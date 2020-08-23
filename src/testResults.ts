// eslint-disable-next-line no-unused-vars
import type { Test } from "@jest/reporters";
// eslint-disable-next-line no-unused-vars
import type { AssertionResult, TestResult } from "@jest/test-result";
import { cleanPath, lineColToRange, openFile, wrapCommand } from "./novaUtils";
import { clean } from "./stackUtils";

// colors pulled from
const successColor = new Color("hex", [21 / 255, 194 / 255, 19 / 255, 1]);
const failureColor = new Color("rgb", [194 / 255, 19 / 255, 37 / 255, 1]);
const pendingColor = new Color("rgb", [194 / 255, 168 / 255, 19 / 255, 1]);

function resultStatusToIssueSeverity(
  status: AssertionResult["status"]
): IssueSeverity | null {
  switch (status) {
    case "passed":
      return null;
    case "failed":
      return IssueSeverity.Error;
    case "skipped":
      return IssueSeverity.Hint;
    case "pending":
      return IssueSeverity.Hint;
    case "todo":
      return IssueSeverity.Hint;
    case "disabled":
      return IssueSeverity.Hint;
  }
}

// store an issue collection per test suite, that way errors can be pushed into different files but still be associated
// with a specific test suite so we don't clear issues from other suites.
// TODO: there's probably a bug if a jest test file gets renamed or deleted - it won't be deleted here
// I probably need to listen for the full test suite completion and need to delete all tests that aren't present
class TestIssueCollections implements Disposable {
  private _collections = new Map<string, IssueCollection>();
  get(suite: string): IssueCollection {
    if (!this._collections.has(suite)) {
      this._collections.set(suite, new IssueCollection());
    }
    return this._collections.get(suite)!;
  }
  dispose() {
    for (const collection of this._collections.values()) {
      collection.dispose();
    }
  }
}

// element is an array of file -> ...ancestorTitles -> test title
interface TestTreeElement {
  segments: ReadonlyArray<string>;
  isLeaf: Boolean;
}

export class TestResultsManager
  implements Disposable, TreeDataProvider<TestTreeElement> {
  private _treeView = new TreeView("apexskier.jest.sidebar.tests", {
    dataProvider: this,
  });
  private _issueCollection = new TestIssueCollections();
  private _storedProcessInfo = new Map<
    string,
    { isRunning: boolean; results?: TestResult }
  >();

  private _compositeDisposable = new CompositeDisposable();

  constructor() {
    this._compositeDisposable.add(this._treeView);
    this._compositeDisposable.add(
      nova.commands.register(
        "apexskier.jest.openTest",
        wrapCommand(this.openTest)
      )
    );
    this._compositeDisposable.add(this._issueCollection);
  }

  async openTest(workspace: Workspace) {
    const open = openFile.bind(workspace);
    const openableElements = this._treeView.selection.filter(
      ({ segments: [, ...ancestors], isLeaf }) =>
        isLeaf || ancestors.length === 0
    );
    const openFiles: { [file: string]: TextEditor | null } = {};
    await Promise.all(
      openableElements.map(async ({ segments: [path] }) => {
        openFiles[path] = await open(path);
        // clear selection
        if (openFiles[path]) {
          (openFiles[path] as any).selectedRange = new Range(0, 0);
        }
      })
    );
    for (const element of openableElements) {
      const {
        segments: [path, ...ancestors],
      } = element;
      const editor = openFiles[path];
      if (!editor) {
        continue;
      }
      const location = this._storedProcessInfo
        .get(path)
        ?.results?.testResults.find(
          (r) => r.title === ancestors[ancestors.length - 1]
        )?.location;
      if (!location) {
        continue;
      }
      const pos = { line: location.line, character: location.column };
      const range = lineColToRange(editor.document, {
        start: pos,
        end: pos,
      });
      editor.addSelectionForRange(range);
      editor.scrollToPosition(range.start);
    }
  }

  getRootElement(k: string): TestTreeElement {
    return {
      segments: [k],
      isLeaf:
        (this._storedProcessInfo.get(k)!.results?.testResults.length ?? 0) ===
        0,
    };
  }

  // TODO: I haven't yet figured out a reliable way to reload a specific element,
  // avoiding reference equality issues, that avoids spamming multiple reloads,
  // which causes annoying flickering issues
  // a simple mechanism would be a debounce, but there's some mores stuff to try.
  reloadTree(key: TestTreeElement | null) {
    console.log("reload", key?.segments.join(":"));
    this._treeView.reload(null);
  }

  handleJestLine(line: string) {
    if (!line.trim()) {
      return;
    }
    const { event, data: rawData } = JSON.parse(line);

    let toReload: TestTreeElement | null = null;
    switch (event) {
      case "onTestStart": {
        const data: Test = rawData;
        const key = nova.path.normalize(data.path);
        // this needs to happen only after initial load, I think
        if (this._storedProcessInfo.has(key)) {
          toReload = this.getRootElement(key);
        }
        this._storedProcessInfo.set(key, {
          isRunning: true,
          results: this._storedProcessInfo.get(key)?.results,
        });
        break;
      }
      case "onTestResult": {
        const data: TestResult = rawData;
        const key = nova.path.normalize(data.testFilePath);
        if (this._storedProcessInfo.has(key)) {
          toReload = this.getRootElement(key);
        }
        this._storedProcessInfo.set(key, { isRunning: false, results: data });
        const fileURI = `file://${key}`;
        // if (nova.inDevMode()) {
        //   console.log("data", JSON.stringify(data, null, "  "));
        // }
        const issueCollection = this._issueCollection.get(fileURI);
        issueCollection.clear();
        for (const result of data.testResults) {
          const severity = resultStatusToIssueSeverity(result.status);
          if (!severity) {
            continue;
          }
          const issue = new Issue();
          // if (nova.inDevMode()) {
          //   console.log("result", JSON.stringify(result, null, "  "));
          // }
          (issue as any).message = result.fullName;
          issue.source = result.title;
          issue.severity = severity;
          if (result.location) {
            issue.line = result.location.line;
            issue.column = result.location.column;
          }
          issueCollection.append(fileURI, [issue]);

          if (Array.isArray(result.failureDetails)) {
            result.failureDetails.map((details: any) => {
              // if (nova.inDevMode()) {
              //   console.log("details", JSON.stringify(details, null, "  "));
              // }
              if (typeof details.stack === "string") {
                const callSite = clean(details.stack);
                if (callSite) {
                  const issue = new Issue();
                  (issue as any).message = details.message;
                  issue.code = result.fullName;
                  issue.severity = IssueSeverity.Error;
                  issue.line = callSite.line;
                  issue.column = callSite.column;
                  issueCollection.append(`file://${callSite.file}`, [issue]);
                }
              }
            });
          }
        }
        break;
      }
      default:
        console.warn("unexpected event", event);
    }
    this.reloadTree(toReload);
  }

  /// MARK Disposable

  dispose() {
    this._compositeDisposable.dispose();
  }

  /// MARK TreeDataProvider

  getChildren(element: TestTreeElement): Array<TestTreeElement> {
    if (!element) {
      return Array.from(this._storedProcessInfo.keys()).map(
        this.getRootElement
      );
    }
    const [path, ...ancestors] = element.segments;
    if (!path) {
      return [];
    }
    if (this._storedProcessInfo.has(path)) {
      let results =
        this._storedProcessInfo.get(path)?.results?.testResults ?? [];
      if (!results) {
        return [];
      }
      ancestors.forEach((ancestor, i) => {
        results = results.filter((r) => r.ancestorTitles[i] == ancestor);
      });
      const nextLevelAncestors: Array<string> = [];
      const children: Array<TestTreeElement> = [];
      for (const r of results) {
        if (r.ancestorTitles.length > ancestors.length) {
          const nextLevelAncestor = r.ancestorTitles[ancestors.length];
          if (!nextLevelAncestors.includes(nextLevelAncestor)) {
            nextLevelAncestors.push(nextLevelAncestor);
            children.push({
              segments: [...element.segments, nextLevelAncestor],
              isLeaf: false,
            });
          }
        } else {
          children.push({
            segments: [...element.segments, r.title],
            isLeaf: true,
          });
        }
      }
      return children;
    }
    return [];
  }

  getTreeItem(element: TestTreeElement) {
    const { segments, isLeaf } = element;
    const elementData = this._storedProcessInfo.get(segments[0]);
    if (!elementData) {
      return new TreeItem("...");
    }
    const { results, isRunning } = elementData;
    const isTestFile = segments.length == 1;
    const title = isTestFile
      ? cleanPath(segments[0])
      : segments[segments.length - 1];
    const collapsedState = isLeaf
      ? TreeItemCollapsibleState.None
      : TreeItemCollapsibleState.Collapsed;
    const item = new TreeItem(title, collapsedState);
    item.command = "apexskier.jest.openTest";
    if (isTestFile) {
      item.path = segments[0];
      if (results?.failureMessage) {
        item.descriptiveText = results.failureMessage;
        item.tooltip = results.failureMessage;
        (item as any).color = failureColor;
      } else {
        (item as any).color = successColor;
      }
      if (isRunning) {
        (item as any).color = pendingColor;
      }
    } else if (isLeaf) {
      const testResult = results?.testResults.find(
        (r) => r.title === item.name
      );
      if (testResult) {
        if (testResult.failureMessages.length > 0) {
          item.descriptiveText = testResult.failureMessages[0];
          item.tooltip = testResult.failureMessages[0];
          (item as any).color = failureColor;
        } else {
          item.tooltip = testResult.fullName;
          (item as any).color = successColor;
        }
        if (isRunning) {
          (item as any).color = pendingColor;
        }
      } else {
        console.warn("Failed to find results", item.name);
      }
    } else {
      item.image = "__builtin.path";
    }
    item.identifier = element.segments.join("__JEST_EXTENSION__");
    return item;
  }

  getParent(element: TestTreeElement) {
    return {
      segments: element.segments.slice(0, -1),
      isLeaf: false,
    };
  }
}
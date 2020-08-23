import * as informationViewModule from "./informationView";
import { TestResultsManager } from "./testResults";

jest.mock("./informationView");
jest.mock("./testResults", () => {
  class TestResultsManager {
    handleJestLine = jest.fn();
  }
  return { TestResultsManager: jest.fn(() => new TestResultsManager()) };
});
jest.mock("stack-utils", () => {
  function StackUtils() {
    return { parseLine: jest.fn() };
  }
  StackUtils.nodeInternals = () => [];
  return { default: StackUtils };
});

jest.mock("./jestExecPath", () => ({
  getJestExecPath: async () => "/jestExecPath",
}));

(global as any).nova = Object.assign(nova, {
  commands: {
    register: jest.fn(),
  },
  workspace: {
    path: "/workspace",
  },
  extension: {
    path: "/extension",
  },
  fs: {
    access: jest.fn(),
  },
  path: {
    join(...args: string[]) {
      return args.join("/");
    },
  },
});

const originalLog = global.console.log;
global.console.log = jest.fn((...args) => {
  if (
    args[0] === "activating..." ||
    args[0] === "activated" ||
    args[0] === "reloading..."
  ) {
    return;
  }
  originalLog(...args);
});
global.console.info = jest.fn();

const CompositeDisposableMock: jest.Mock<Partial<
  CompositeDisposable
>> = jest
  .fn()
  .mockImplementation(() => ({ add: jest.fn(), dispose: jest.fn() }));
(global as any).CompositeDisposable = CompositeDisposableMock;
const ProcessMock: jest.Mock<Partial<Process>> = jest.fn();
(global as any).Process = ProcessMock;
const ColorMock: jest.Mock<Partial<Color>> = jest.fn();
(global as any).Color = ColorMock;

describe("test suite", () => {
  // dynamically require so global mocks are setup before top level code execution
  const { activate, deactivate } = require("./main");

  function resetMocks() {
    nova.fs.access = jest.fn().mockReturnValue(true);
    (nova.commands.register as jest.Mock).mockReset();
    ProcessMock.mockReset().mockImplementation(() => ({
      onStdout: jest.fn(),
      onStderr: jest.fn(),
      onDidExit: jest.fn((cb) => cb(0)),
      start: jest.fn(),
    }));
    (informationViewModule.InformationView as jest.Mock).mockReset();
  }

  const reload = (nova.commands.register as jest.Mock).mock.calls.find(
    ([command]) => command == "apexskier.jest.reload"
  )[1];

  test("global behavior", () => {
    expect(nova.commands.register).toBeCalledTimes(2);
    expect(nova.commands.register).toBeCalledWith(
      "apexskier.jest.openWorkspaceConfig",
      expect.any(Function)
    );
    expect(nova.commands.register).toBeCalledWith(
      "apexskier.jest.reload",
      expect.any(Function)
    );

    expect(CompositeDisposable).toBeCalledTimes(1);
  });

  function assertActivationBehavior() {
    expect(Process).toBeCalledTimes(2);
    expect(Process).toHaveBeenNthCalledWith(1, "/jestExecPath", {
      args: ["--version"],
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(Process).toHaveBeenNthCalledWith(2, "/jestExecPath", {
      args: [
        "--watchAll",
        "--testLocationInResults",
        "--reporters",
        "/extension/Scripts/reporter.dist.js",
      ],
      cwd: "/workspace",
      env: {
        CI: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(informationViewModule.InformationView).toBeCalledTimes(1);
    const informationView = (informationViewModule.InformationView as jest.Mock<
      informationViewModule.InformationView
    >).mock.instances[0];
    expect(informationView.status).toBe("Running");
    expect(informationView.reload).toBeCalledTimes(1);
  }

  describe("activate and deactivate", () => {
    it("gets jest, and runs it", async () => {
      resetMocks();

      (ProcessMock as jest.Mock<Partial<Process>>)
        .mockImplementationOnce(() => ({
          onStdout: jest.fn((cb) => cb("jest v1.2.3\n")),
          onStderr: jest.fn(),
          onDidExit: jest.fn(),
          start: jest.fn(),
        }))
        .mockImplementationOnce(() => ({
          onStdout: jest.fn(),
          onStderr: jest.fn(),
          onDidExit: jest.fn((cb) => cb(0)),
          start: jest.fn(),
        }));

      await activate();

      assertActivationBehavior();

      // jest version is reported in the information view
      const informationView = (informationViewModule.InformationView as jest.Mock<
        informationViewModule.InformationView
      >).mock.instances[0];
      expect(informationView.jestVersion).toBeUndefined();
      const jestVersionProcess: Process = ProcessMock.mock.results[0].value;
      const exitCB = (jestVersionProcess.onDidExit as jest.Mock).mock
        .calls[0][0];
      exitCB(0);
      // allow promise to execute
      await new Promise(setImmediate);
      expect(informationView.jestVersion).toBe("jest v1.2.3");

      // sends jest events to results manager
      const jestProcess: Process = ProcessMock.mock.results[1].value;
      const testResultsManager: TestResultsManager = (TestResultsManager as jest.Mock)
        .mock.results[0].value;
      const stdOutCB = (jestProcess.onStdout as jest.Mock).mock.calls[0][0];
      const mockEvent = Symbol();
      stdOutCB(mockEvent);
      expect(testResultsManager.handleJestLine).toBeCalledTimes(1);
      expect(testResultsManager.handleJestLine).toBeCalledWith(mockEvent);

      deactivate();

      const compositeDisposable: CompositeDisposable =
        CompositeDisposableMock.mock.results[0].value;
      expect(compositeDisposable.dispose).toBeCalledTimes(1);
    });

    test("reload", async () => {
      resetMocks();

      await reload();

      const compositeDisposable: CompositeDisposable =
        CompositeDisposableMock.mock.results[0].value;
      expect(compositeDisposable.dispose).toBeCalledTimes(2);

      assertActivationBehavior();
    });
  });
});
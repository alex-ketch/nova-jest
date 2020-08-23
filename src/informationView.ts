type Element = {
  title: string;
  value: string;
  readonly identifier: string;
};

export class InformationView {
  constructor() {
    this._treeView = new TreeView("apexskier.jest.sidebar.info", {
      dataProvider: this,
    });

    this.getChildren = this.getChildren.bind(this);
    this.getTreeItem = this.getTreeItem.bind(this);
  }

  private _treeView: TreeView<{ title: string; value: string }>;

  private readonly _statusElement: Element = {
    title: "Status",
    value: "Inactive",
    identifier: "status",
  };
  public set status(value: string) {
    this._statusElement.value = value;
    this._treeView.reload(this._statusElement);
  }

  private readonly _versionElement: Element = {
    title: "Jest Version",
    value: "",
    identifier: "version",
  };
  public set jestVersion(value: string) {
    this._versionElement.value = value;
    this._treeView.reload(this._versionElement);
  }

  reload() {
    this._treeView.reload();
  }

  getChildren(element: Element | null): Array<Element> {
    if (element == null) {
      return [this._statusElement, this._versionElement];
    }
    return [];
  }

  getTreeItem(element: Element) {
    const item = new TreeItem(element.title, TreeItemCollapsibleState.None);
    item.descriptiveText = element.value;
    item.identifier = element.identifier;
    return item;
  }
}

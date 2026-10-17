export class TestExtensionUri {
  constructor(public readonly path = process.cwd(), public readonly scheme = 'file', public readonly authority = '') {}
  get fsPath() { return this.path; }
  with(changes: { path: string }) { return new TestExtensionUri(changes.path, this.scheme, this.authority); }
  toString() { return `${this.scheme}://${this.authority}${this.path}`; }
}

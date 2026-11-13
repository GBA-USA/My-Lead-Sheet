/** Just enough DOM for React to mount the sheet and dispatch clicks in Node. */

type Listener = { type: string; run: (event: object) => void; capture: boolean };

class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeElement | null = null;
  nodeValue: string | null = null;
  readonly nodeType: number;
  readonly nodeName: string;
  readonly ownerDocument: FakeDocument;
  constructor(nodeType: number, nodeName: string, ownerDocument: FakeDocument) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.ownerDocument = ownerDocument;
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get textContent(): string {
    return this.nodeType === 3 ? (this.nodeValue ?? "") : this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(text: string) {
    if (this.nodeType === 3) {
      this.nodeValue = text;
      return;
    }
    this.childNodes.forEach((child) => (child.parentNode = null));
    this.childNodes = text ? [this.ownerDocument.createTextNode(text)] : [];
    this.childNodes.forEach((child) => (child.parentNode = this as unknown as FakeElement));
  }
}

class FakeElement extends FakeNode {
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly attributes = new Map<string, string>();
  readonly listeners: Listener[] = [];
  readonly style = { setProperty() {}, removeProperty() {} };
  readonly dataset = new Proxy({} as Record<string, string>, {
    get: (_, key) => this.attributes.get(`data-${String(key)}`),
    set: (_, key, value) => {
      this.attributes.set(`data-${String(key)}`, String(value));
      return true;
    },
  });
  value = "";
  clientWidth = 360;
  get tagName() {
    return this.nodeName;
  }
  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  appendChild(child: FakeNode) {
    return this.insertBefore(child, null);
  }
  insertBefore(child: FakeNode, before: FakeNode | null) {
    child.parentNode?.removeChild(child);
    const at = before ? this.childNodes.indexOf(before) : -1;
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: FakeNode) {
    this.childNodes = this.childNodes.filter((node) => node !== child);
    child.parentNode = null;
    return child;
  }
  addEventListener(type: string, run: (event: object) => void, options?: boolean | { capture?: boolean }) {
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    this.listeners.push({ type, run, capture });
  }
  removeEventListener(type: string, run: (event: object) => void) {
    const index = this.listeners.findIndex((listener) => listener.type === type && listener.run === run);
    if (index >= 0) this.listeners.splice(index, 1);
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
  }
  select() {}
  contains(node: FakeElement | null): boolean {
    for (let at = node; at; at = at.parentNode) if (at === this) return true;
    return false;
  }
  getContext() {
    return null;
  }
  get elements(): FakeElement[] {
    return this.childNodes.flatMap((child) => (child instanceof FakeElement ? [child, ...child.elements] : []));
  }
}

class FakeDocument extends FakeElement {
  activeElement: FakeElement | null = null;
  visibilityState = "visible";
  readonly body: FakeElement;
  constructor() {
    super(9, "#document", undefined as unknown as FakeDocument);
    Object.defineProperty(this, "ownerDocument", { value: this });
    this.body = this.appendChild(this.createElement("body")) as FakeElement;
  }
  createElement(name: string) {
    return new FakeElement(1, name.toUpperCase(), this);
  }
  createTextNode(text: string) {
    const node = new FakeNode(3, "#text", this);
    node.nodeValue = text;
    return node;
  }
}

export type { FakeElement };

export function fakeDom() {
  const document = new FakeDocument();
  const container = document.createElement("div");
  document.body.appendChild(container);

  /** Fires a click the way a browser does: capture listeners on the way down, then bubble listeners up. */
  const click = (target: FakeElement) => {
    const path: FakeElement[] = [];
    for (let node: FakeElement | null = target; node; node = node.parentNode) path.push(node);
    let stopped = false;
    const event = {
      type: "click",
      target,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      detail: 1,
      timeStamp: 0,
      preventDefault() {
        event.defaultPrevented = true;
      },
      stopPropagation() {
        stopped = true;
      },
    };
    const phases: [FakeElement[], boolean][] = [
      [[...path].reverse(), true],
      [path, false],
    ];
    for (const [nodes, capture] of phases) {
      for (const node of nodes) {
        for (const listener of node.listeners.filter((each) => each.type === "click" && each.capture === capture)) {
          listener.run(event);
        }
        if (stopped) return;
      }
    }
  };

  return { document, container, click };
}

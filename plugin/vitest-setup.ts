import "@testing-library/jest-dom/vitest";

type ObsidianDomElementInfo = {
  cls?: string | string[];
  text?: string;
};

const applyDomElementInfo = (
  element: HTMLElement,
  options?: DomElementInfo | string,
): void => {
  const classes = typeof options === "string" ? options : options?.cls;
  if (typeof classes === "string") {
    element.className = classes;
  } else if (classes !== undefined) {
    element.classList.add(...classes);
  }
  if (typeof options !== "string" && options?.text !== undefined) {
    if (typeof options.text === "string") {
      element.textContent = options.text;
    } else {
      element.append(options.text);
    }
  }
};

// Obsidian adds Array.prototype.remove; polyfill it for tests.
declare global {
  interface Array<T> {
    remove(item: T): void;
  }
}

if (!Array.prototype.remove) {
  Array.prototype.remove = function <T>(this: T[], item: T): void {
    const index = this.indexOf(item);
    if (index > -1) {
      this.splice(index, 1);
    }
  };
}

if (!HTMLElement.prototype.empty) {
  HTMLElement.prototype.empty = function (): void {
    this.replaceChildren();
  };
}

if (!Node.prototype.createEl) {
  Node.prototype.createEl = function <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options?: DomElementInfo | string,
    callback?: (element: HTMLElementTagNameMap[K]) => void,
  ): HTMLElementTagNameMap[K] {
    const element = (this.ownerDocument ?? document).createElement(tag);
    applyDomElementInfo(element, options);
    callback?.(element);
    this.appendChild(element);
    return element;
  };
}

if (!Node.prototype.createSpan) {
  Node.prototype.createSpan = function (
    options?: DomElementInfo | string,
    callback?: (element: HTMLSpanElement) => void,
  ): HTMLSpanElement {
    return this.createEl("span", options, callback);
  };
}

if (typeof globalThis.createFragment !== "function") {
  globalThis.createFragment = (callback?: (element: DocumentFragment) => void) => {
    const fragment = document.createDocumentFragment();
    callback?.(fragment);
    return fragment;
  };
}

if (!HTMLElement.prototype.createDiv) {
  HTMLElement.prototype.createDiv = function (
    options?: ObsidianDomElementInfo | string,
  ): HTMLDivElement {
    const element = this.ownerDocument.createElement("div");
    const classes = typeof options === "string" ? options : options?.cls;
    if (typeof classes === "string") {
      element.className = classes;
    } else if (classes !== undefined) {
      element.classList.add(...classes);
    }
    if (typeof options !== "string" && options?.text !== undefined) {
      element.textContent = options.text;
    }
    this.append(element);
    return element;
  };
}

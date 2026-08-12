import "@testing-library/jest-dom/vitest";

type ObsidianDomElementInfo = {
  cls?: string | string[];
  text?: string;
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

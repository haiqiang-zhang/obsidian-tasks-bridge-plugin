// biome-ignore lint/correctness/noUnusedFunctionParameters: mocks with empty impl
export function setIcon(parent: HTMLElement, iconId: string, size?: number): void {}

// biome-ignore lint/correctness/noUnusedFunctionParameters: mocks with empty impl
export function setTooltip(el: HTMLElement, text: string, options?: TooltipOptions): void {}

export type TooltipOptions = {
  placement?: string;
};

export class App {}

export abstract class AbstractInputSuggest<T> {
  readonly app: App;
  limit = 100;
  private onSelectCallback: ((value: T, evt: MouseEvent | KeyboardEvent) => unknown) | null = null;
  private suggestionContainerEl: HTMLElement | null = null;
  private readonly textInputEl: HTMLInputElement | HTMLDivElement;

  constructor(app: App, textInputEl: HTMLInputElement | HTMLDivElement) {
    this.app = app;
    this.textInputEl = textInputEl;
    textInputEl.addEventListener("input", () => void this.showSuggestions());
    textInputEl.addEventListener("focus", () => void this.showSuggestions());
  }

  protected abstract getSuggestions(query: string): T[] | Promise<T[]>;

  abstract renderSuggestion(value: T, el: HTMLElement): void;

  setValue(value: string): void {
    if (this.textInputEl instanceof HTMLInputElement) {
      this.textInputEl.value = value;
      return;
    }
    this.textInputEl.textContent = value;
  }

  getValue(): string {
    return this.textInputEl instanceof HTMLInputElement
      ? this.textInputEl.value
      : (this.textInputEl.textContent ?? "");
  }

  onSelect(callback: (value: T, evt: MouseEvent | KeyboardEvent) => unknown): this {
    this.onSelectCallback = callback;
    return this;
  }

  selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void {
    this.onSelectCallback?.(value, evt);
    this.close();
  }

  open(): void {
    void this.showSuggestions();
  }

  close(): void {
    this.suggestionContainerEl?.remove();
    this.suggestionContainerEl = null;
  }

  private async showSuggestions(): Promise<void> {
    const suggestions = await this.getSuggestions(this.getValue());
    this.close();
    if (suggestions.length === 0) {
      return;
    }

    const containerEl = document.createElement("div");
    containerEl.className = "suggestion-container";
    for (const suggestion of suggestions.slice(0, this.limit)) {
      const itemEl = document.createElement("div");
      itemEl.className = "suggestion-item";
      this.renderSuggestion(suggestion, itemEl);
      itemEl.addEventListener("click", (event) => this.selectSuggestion(suggestion, event));
      containerEl.append(itemEl);
    }
    document.body.append(containerEl);
    this.suggestionContainerEl = containerEl;
  }
}

export class SearchComponent {
  readonly clearButtonEl: HTMLButtonElement;
  readonly inputEl: HTMLInputElement;
  private onChangeCallback: ((value: string) => unknown) | null = null;

  constructor(containerEl: HTMLElement) {
    const searchContainerEl = document.createElement("div");
    searchContainerEl.className = "search-input-container";
    this.inputEl = document.createElement("input");
    this.inputEl.type = "search";
    this.inputEl.addEventListener("input", () => this.onChanged());
    this.clearButtonEl = document.createElement("button");
    this.clearButtonEl.type = "button";
    this.clearButtonEl.className = "search-input-clear-button";
    this.clearButtonEl.setAttribute("aria-label", "Clear search");
    this.clearButtonEl.addEventListener("click", () => {
      this.inputEl.value = "";
      this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    });
    searchContainerEl.append(this.inputEl, this.clearButtonEl);
    containerEl.append(searchContainerEl);
  }

  getValue(): string {
    return this.inputEl.value;
  }

  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }

  setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder;
    return this;
  }

  onChange(callback: (value: string) => unknown): this {
    this.onChangeCallback = callback;
    return this;
  }

  onChanged(): void {
    this.onChangeCallback?.(this.inputEl.value);
  }
}

export const prepareFuzzySearch =
  (query: string) =>
  (text: string): { score: number; matches: [number, number][] } | null => {
    const index = text.toLocaleLowerCase("en-US").indexOf(query.toLocaleLowerCase("en-US"));
    return index === -1
      ? null
      : {
          score: index,
          matches: [[index, index + query.length]],
        };
  };

export class PluginSettingTab {}
export class Setting {}

export class MarkdownRenderChild {
  containerEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    this.containerEl = containerEl;
  }
}

export class Notice {}

export class Menu {
  addItem(cb: (item: MenuItem) => void): this {
    cb(new MenuItem());
    return this;
  }
  // biome-ignore lint/correctness/noUnusedFunctionParameters: mocks with empty impl
  showAtPosition(position: { x: number; y: number }): this {
    return this;
  }
}

export class MenuItem {
  // biome-ignore lint/correctness/noUnusedFunctionParameters: mocks with empty impl
  setTitle(title: string): this {
    return this;
  }
  // biome-ignore lint/correctness/noUnusedFunctionParameters: mocks with empty impl
  setIcon(icon: string | null): this {
    return this;
  }
  // biome-ignore lint/correctness/noUnusedFunctionParameters: mocks with empty impl
  onClick(cb: (evt: MouseEvent | KeyboardEvent) => void): this {
    return this;
  }
}

// biome-ignore lint/complexity/noStaticOnlyClass: mock must match Obsidian's class-based API
export class MarkdownRenderer {
  static renderMarkdown(
    markdown: string,
    el: HTMLElement,
    _sourcePath: string,
    _component: unknown,
  ): Promise<void> {
    el.textContent = markdown;
    return Promise.resolve();
  }
}

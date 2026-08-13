export function setIcon(parent: HTMLElement, iconId: string, _size?: number): void {
  parent.dataset.icon = iconId;
}

// biome-ignore lint/correctness/noUnusedFunctionParameters: mocks with empty impl
export function setTooltip(el: HTMLElement, text: string, options?: TooltipOptions): void {}

export type TooltipOptions = {
  placement?: string;
};

export class App {}

type SearchMatch = [number, number];

type FuzzyMatch<T> = {
  item: T;
  match: { score: number; matches: SearchMatch[] };
};

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
    const notifyChanged = () => this.onChanged();
    this.inputEl.addEventListener("input", notifyChanged);
    this.inputEl.addEventListener("change", notifyChanged);
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

export class ButtonComponent {
  readonly buttonEl: HTMLButtonElement;
  private onClickCallback: ((evt: MouseEvent) => unknown) | null = null;

  constructor(containerEl: HTMLElement) {
    this.buttonEl = document.createElement("button");
    this.buttonEl.type = "button";
    this.buttonEl.addEventListener("click", (event) => this.onClickCallback?.(event));
    containerEl.append(this.buttonEl);
  }

  setButtonText(text: string): this {
    this.buttonEl.textContent = text;
    return this;
  }

  setCta(): this {
    this.buttonEl.classList.add("mod-cta");
    return this;
  }

  onClick(callback: (evt: MouseEvent) => unknown): this {
    this.onClickCallback = callback;
    return this;
  }
}

export class ToggleComponent {
  readonly toggleEl: HTMLInputElement;
  private onChangeCallback: ((value: boolean) => unknown) | null = null;

  constructor(containerEl: HTMLElement) {
    this.toggleEl = document.createElement("input");
    this.toggleEl.type = "checkbox";
    this.toggleEl.className = "checkbox-container";
    this.toggleEl.addEventListener("change", () => this.onChangeCallback?.(this.getValue()));
    containerEl.append(this.toggleEl);
  }

  getValue(): boolean {
    return this.toggleEl.checked;
  }

  setValue(value: boolean): this {
    this.toggleEl.checked = value;
    return this;
  }

  onChange(callback: (value: boolean) => unknown): this {
    this.onChangeCallback = callback;
    return this;
  }
}

export class DropdownComponent {
  readonly selectEl: HTMLSelectElement;
  disabled = false;
  private onChangeCallback: ((value: string) => unknown) | null = null;

  constructor(containerEl: HTMLElement) {
    this.selectEl = document.createElement("select");
    this.selectEl.className = "dropdown";
    this.selectEl.addEventListener("change", () => {
      this.onChangeCallback?.(this.selectEl.value);
    });
    containerEl.append(this.selectEl);
  }

  addOption(value: string, display: string): this {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = display;
    this.selectEl.append(option);
    return this;
  }

  addOptions(options: Record<string, string>): this {
    for (const [value, display] of Object.entries(options)) {
      this.addOption(value, display);
    }
    return this;
  }

  getValue(): string {
    return this.selectEl.value;
  }

  setValue(value: string): this {
    this.selectEl.value = value;
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    this.selectEl.disabled = disabled;
    return this;
  }

  onChange(callback: (value: string) => unknown): this {
    this.onChangeCallback = callback;
    return this;
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

export class Modal {
  readonly app: App;
  readonly containerEl: HTMLElement;
  readonly modalEl: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly contentEl: HTMLElement;
  private closeCallback: (() => unknown) | null = null;

  constructor(app: App) {
    this.app = app;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "modal-container";
    this.modalEl = document.createElement("div");
    this.modalEl.className = "modal";
    this.modalEl.setAttribute("role", "dialog");
    this.titleEl = document.createElement("div");
    this.titleEl.className = "modal-title";
    this.contentEl = document.createElement("div");
    this.contentEl.className = "modal-content";
    this.modalEl.append(this.titleEl, this.contentEl);
    this.containerEl.append(this.modalEl);
  }

  setTitle(title: string): this {
    this.titleEl.textContent = title;
    this.modalEl.setAttribute("aria-label", title);
    return this;
  }

  open(): void {
    document.body.append(this.containerEl);
    this.onOpen();
  }

  close(): void {
    this.onClose();
    this.containerEl.remove();
    this.closeCallback?.();
  }

  onOpen(): void {}

  onClose(): void {}

  setCloseCallback(callback: () => unknown): this {
    this.closeCallback = callback;
    return this;
  }
}

export abstract class FuzzySuggestModal<T> extends Modal {
  limit = 100;
  emptyStateText = "No results found";
  readonly inputEl: HTMLInputElement;
  readonly resultContainerEl: HTMLElement;

  constructor(app: App) {
    super(app);
    this.inputEl = document.createElement("input");
    this.inputEl.type = "search";
    this.inputEl.className = "prompt-input";
    this.resultContainerEl = document.createElement("div");
    this.resultContainerEl.className = "suggestion-container";
    this.contentEl.append(this.inputEl, this.resultContainerEl);
    const refresh = () => this.renderSuggestions();
    this.inputEl.addEventListener("input", refresh);
    this.inputEl.addEventListener("change", refresh);
  }

  abstract getItems(): T[];

  abstract getItemText(item: T): string;

  abstract onChooseItem(item: T, evt: MouseEvent | KeyboardEvent): void;

  setPlaceholder(placeholder: string): void {
    this.inputEl.placeholder = placeholder;
  }

  override onOpen(): void {
    this.renderSuggestions();
  }

  getSuggestions(query: string): FuzzyMatch<T>[] {
    const search = prepareFuzzySearch(query);
    return this.getItems()
      .map((item) => {
        const match = search(this.getItemText(item));
        return match === null ? null : { item, match };
      })
      .filter((match): match is FuzzyMatch<T> => match !== null)
      .slice(0, this.limit);
  }

  renderSuggestion(match: FuzzyMatch<T>, el: HTMLElement): void {
    el.textContent = this.getItemText(match.item);
  }

  private renderSuggestions(): void {
    this.resultContainerEl.replaceChildren();
    const matches = this.getSuggestions(this.inputEl.value);
    if (matches.length === 0) {
      this.resultContainerEl.textContent = this.emptyStateText;
      return;
    }
    for (const match of matches) {
      const itemEl = document.createElement("button");
      itemEl.type = "button";
      itemEl.className = "suggestion-item";
      this.renderSuggestion(match, itemEl);
      itemEl.addEventListener("click", (event) => {
        this.onChooseItem(match.item, event);
        this.close();
      });
      this.resultContainerEl.append(itemEl);
    }
  }
}

export function renderResults(
  el: HTMLElement,
  text: string,
  _result: { score: number; matches: SearchMatch[] },
): void {
  el.textContent = text;
}

export class PluginSettingTab {}

export class Setting {
  readonly settingEl: HTMLElement;
  readonly infoEl: HTMLElement;
  readonly nameEl: HTMLElement;
  readonly descEl: HTMLElement;
  readonly controlEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    this.settingEl = document.createElement("div");
    this.settingEl.className = "setting-item";
    this.infoEl = document.createElement("div");
    this.infoEl.className = "setting-item-info";
    this.nameEl = document.createElement("div");
    this.nameEl.className = "setting-item-name";
    this.descEl = document.createElement("div");
    this.descEl.className = "setting-item-description";
    this.infoEl.append(this.nameEl, this.descEl);
    this.controlEl = document.createElement("div");
    this.controlEl.className = "setting-item-control";
    this.settingEl.append(this.infoEl, this.controlEl);
    containerEl.append(this.settingEl);
  }

  setName(name: string | DocumentFragment): this {
    this.nameEl.replaceChildren(name);
    return this;
  }

  setClass(className: string): this {
    this.settingEl.classList.add(className);
    return this;
  }

  addSearch(callback: (component: SearchComponent) => unknown): this {
    callback(new SearchComponent(this.controlEl));
    return this;
  }

  addToggle(callback: (component: ToggleComponent) => unknown): this {
    callback(new ToggleComponent(this.controlEl));
    return this;
  }

  addButton(callback: (component: ButtonComponent) => unknown): this {
    callback(new ButtonComponent(this.controlEl));
    return this;
  }
}

export class MarkdownRenderChild {
  containerEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    this.containerEl = containerEl;
  }
}

export class Notice {}

export class Menu {
  setUseNativeMenu(_useNativeMenu: boolean): this {
    return this;
  }
  setParentElement(_el: HTMLElement): this {
    return this;
  }
  addItem(cb: (item: MenuItem) => void): this {
    cb(new MenuItem());
    return this;
  }
  // biome-ignore lint/correctness/noUnusedFunctionParameters: mocks with empty impl
  showAtPosition(position: { x: number; y: number }, _doc?: Document): this {
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
  setChecked(_checked: boolean | null): this {
    return this;
  }
  setDisabled(_disabled: boolean): this {
    return this;
  }
  setSection(_section: string): this {
    return this;
  }
  // biome-ignore lint/correctness/noUnusedFunctionParameters: mocks with empty impl
  onClick(cb: (evt: MouseEvent | KeyboardEvent) => void): this {
    return this;
  }
}

// biome-ignore lint/complexity/noStaticOnlyClass: mock must match Obsidian's class-based API
export class MarkdownRenderer {
  static render(
    _app: App,
    markdown: string,
    el: HTMLElement,
    _sourcePath: string,
    _component: unknown,
  ): Promise<void> {
    el.textContent = markdown;
    return Promise.resolve();
  }

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

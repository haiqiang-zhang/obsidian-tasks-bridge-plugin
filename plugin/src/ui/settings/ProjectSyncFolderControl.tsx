import { AbstractInputSuggest, type App, prepareFuzzySearch, SearchComponent } from "obsidian";
import type React from "react";
import { useLayoutEffect, useRef } from "react";

import { t } from "@/i18n";
import { PluginContext } from "@/ui/context";

type Props = {
  ariaDescribedBy?: string;
  ariaLabel?: string;
  folders: string[];
  id?: string;
  invalid?: boolean;
  value: string;
  onChange: (value: string) => Promise<void>;
};

class VaultFolderSuggest extends AbstractInputSuggest<string> {
  private readonly getFolders: () => string[];

  constructor(app: App, inputEl: HTMLInputElement, getFolders: () => string[]) {
    super(app, inputEl);
    this.getFolders = getFolders;
  }

  protected getSuggestions(query: string): string[] {
    const folders = this.getFolders();
    const normalizedQuery = query.trim();
    if (normalizedQuery.length === 0) {
      return folders;
    }

    const fuzzySearch = prepareFuzzySearch(normalizedQuery);
    return folders.filter((folder) => fuzzySearch(folder) !== null);
  }

  renderSuggestion(folder: string, el: HTMLElement): void {
    el.textContent = folder;
  }
}

export const ProjectSyncFolderControl: React.FC<Props> = ({
  ariaDescribedBy,
  ariaLabel,
  folders,
  id,
  invalid = false,
  value,
  onChange,
}) => {
  const plugin = PluginContext.use();
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<SearchComponent>(null);
  const foldersRef = useRef(folders);
  const onChangeRef = useRef(onChange);
  const i18n = t().settings.projectSync.folder;

  foldersRef.current = folders;
  onChangeRef.current = onChange;

  useLayoutEffect(() => {
    const containerEl = containerRef.current;
    if (containerEl === null) {
      return;
    }

    const search = new SearchComponent(containerEl);
    search.inputEl.classList.add("project-sync-folder-input");
    search.onChange((folder) => void onChangeRef.current(folder));

    const suggest = new VaultFolderSuggest(plugin.app, search.inputEl, () => foldersRef.current);
    suggest.onSelect((folder) => {
      search.setValue(folder);
      void onChangeRef.current(folder);
    });
    searchRef.current = search;

    return () => {
      suggest.close();
      searchRef.current = null;
      containerEl.replaceChildren();
    };
  }, [plugin.app]);

  useLayoutEffect(() => {
    const search = searchRef.current;
    if (search === null) {
      return;
    }

    if (search.getValue() !== value) {
      search.setValue(value);
    }
    search.setPlaceholder(i18n.placeholder);

    const { inputEl } = search;
    setOptionalAttribute(inputEl, "id", id);
    setOptionalAttribute(inputEl, "aria-describedby", ariaDescribedBy);
    inputEl.setAttribute("aria-label", ariaLabel ?? i18n.label);
    inputEl.setAttribute("aria-invalid", String(invalid));
  }, [ariaDescribedBy, ariaLabel, i18n.label, i18n.placeholder, id, invalid, value]);

  return <div className="project-sync-folder-selector" ref={containerRef} />;
};

const setOptionalAttribute = (
  inputEl: HTMLInputElement,
  attribute: string,
  value: string | undefined,
): void => {
  if (value === undefined) {
    inputEl.removeAttribute(attribute);
    return;
  }
  inputEl.setAttribute(attribute, value);
};

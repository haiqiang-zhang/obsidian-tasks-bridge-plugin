import { Menu } from "obsidian";
import { useCallback, useEffect, useRef, useState } from "react";

/** Opens an Obsidian menu anchored to a React button. */
export const useObsidianMenu = (configure: (menu: Menu) => void) => {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<Menu | null>(null);
  const configureRef = useRef(configure);
  const [isOpen, setIsOpen] = useState(false);
  configureRef.current = configure;

  const openMenu = useCallback(() => {
    const anchor = anchorRef.current;
    if (anchor === null) {
      return;
    }

    menuRef.current?.close();

    const menu = new Menu().setParentElement(anchor);
    configureRef.current(menu);
    menu.onHide(() => {
      if (menuRef.current === menu) {
        menuRef.current = null;
        setIsOpen(false);
      }
    });
    menuRef.current = menu;
    setIsOpen(true);

    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom, width: rect.width }, anchor.ownerDocument);
  }, []);

  useEffect(
    () => () => {
      const menu = menuRef.current;
      menuRef.current = null;
      menu?.close();
    },
    [],
  );

  return { anchorRef, isOpen, openMenu };
};

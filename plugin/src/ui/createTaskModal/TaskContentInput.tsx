import classNames from "classnames";
import type React from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { TextField } from "react-aria-components";
import TextareaAutosize from "react-textarea-autosize";

type Props = {
  className: string;
  placeholder: string;
  content: string;
  onChange: (content: string) => void;
  autofocus?: boolean;
  onEnterKey?: () => Promise<void>;
};

export const TaskContentInput: React.FC<Props> = ({
  className,
  placeholder,
  content,
  onChange,
  onEnterKey,
  autofocus,
}) => {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [, setLayoutWidth] = useState(0);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input === null) {
      return;
    }
    const viewWindow = input.ownerDocument.defaultView;
    const Observer = viewWindow?.ResizeObserver;
    if (viewWindow === null || Observer === undefined) {
      return;
    }
    // Modal scrollbars can change the available width without a window resize.
    // A width change rerenders Autosize so it measures the newly wrapped lines.
    let observedWidth: number | undefined;
    let resizeFrame: number | undefined;
    const observer = new Observer(([entry]) => {
      const width = entry?.contentRect.width;
      if (width === undefined || width === observedWidth) {
        return;
      }
      observedWidth = width;
      if (resizeFrame !== undefined) {
        viewWindow.cancelAnimationFrame(resizeFrame);
      }
      // Autosize changes height; defer that write until after observer delivery.
      resizeFrame = viewWindow.requestAnimationFrame(() => {
        resizeFrame = undefined;
        setLayoutWidth(width);
      });
    });
    observer.observe(input);
    return () => {
      observer.disconnect();
      if (resizeFrame !== undefined) {
        viewWindow.cancelAnimationFrame(resizeFrame);
      }
    };
  }, []);

  const onInputChange = (ev: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(ev.target.value);
  };

  const onKeyDown = (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (onEnterKey === undefined) {
      return;
    }

    if (ev.nativeEvent.isComposing) {
      return;
    }

    if (ev.key === "Enter") {
      ev.preventDefault();
      void onEnterKey();
    }
  };

  const classes = classNames("task-content-input", className);
  return (
    <TextField className={classes} aria-label={placeholder}>
      <TextareaAutosize
        ref={inputRef}
        className={classes}
        placeholder={placeholder}
        value={content}
        onChange={onInputChange}
        aria-label={placeholder}
        autoFocus={autofocus}
        onKeyDown={onKeyDown}
      />
    </TextField>
  );
};

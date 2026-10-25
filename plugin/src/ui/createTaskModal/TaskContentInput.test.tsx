import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { TaskContentInput } from "./TaskContentInput";

type ObserverRecord = {
  callback: ResizeObserverCallback;
  targets: Element[];
  disconnect: Mock<() => void>;
};

let observers: ObserverRecord[];
let stylesheet: HTMLStyleElement;
let measurements: number;
let frames: Map<number, FrameRequestCallback>;

beforeEach(() => {
  observers = [];
  measurements = 0;
  frames = new Map();
  let nextFrameId = 0;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => {
      frames.delete(id);
    }),
  );
  class MockResizeObserver {
    private readonly record: ObserverRecord;

    constructor(callback: ResizeObserverCallback) {
      this.record = { callback, targets: [], disconnect: vi.fn() };
      observers.push(this.record);
    }

    observe(target: Element): void {
      this.record.targets.push(target);
    }

    unobserve(): void {}

    disconnect(): void {
      this.record.disconnect();
    }
  }
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  stylesheet = document.createElement("style");
  stylesheet.textContent = `
    .task-content-input textarea {
      box-sizing: border-box;
      width: 264px;
      padding: 0;
      border: 0;
      font-size: 16px;
      line-height: 20px;
    }
  `;
  document.head.append(stylesheet);

  // JSDOM has no text layout. Supply deterministic wrapping for the real autosize
  // library's measurement textarea, so a width change requires a different height.
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (!(this instanceof HTMLTextAreaElement)) {
      return 0;
    }
    measurements += 1;
    const columns = Math.max(1, Math.floor(Number.parseFloat(this.style.width) / 10));
    const rows = this.value
      .split("\n")
      .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / columns)), 0);
    return rows * 20;
  });
});

afterEach(() => {
  cleanup();
  stylesheet.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function flushFrames() {
  act(() => {
    for (const [id, callback] of [...frames]) {
      frames.delete(id);
      callback(0);
    }
  });
}

function renderDescription(content = "复".repeat(910)) {
  const onChange = vi.fn();
  const rendered = render(
    <TaskContentInput
      className="task-description"
      placeholder="Description"
      content={content}
      onChange={onChange}
    />,
  );
  const textarea = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Description" });
  const observer = observers.find((record) => record.targets.includes(textarea));
  if (observer === undefined) {
    throw new Error("The textarea width must be observed independently of the window");
  }

  const resize = (width: number, height: number) => {
    textarea.style.width = `${width}px`;
    act(() => {
      observer.callback(
        [
          {
            target: textarea,
            contentRect: new DOMRect(0, 0, width, height),
            borderBoxSize: [{ inlineSize: width, blockSize: height }],
            contentBoxSize: [{ inlineSize: width, blockSize: height }],
            devicePixelContentBoxSize: [{ inlineSize: width, blockSize: height }],
          },
        ],
        {} as ResizeObserver,
      );
    });
  };
  return { ...rendered, textarea, observer, resize, onChange };
}

describe("TaskContentInput sizing", () => {
  it("remeasures wrapped content when a modal scrollbar changes its width without a window resize", () => {
    const { textarea, resize, onChange } = renderDescription();
    const initialHeight = Number.parseFloat(textarea.style.height);
    expect(initialHeight).toBe(700);

    resize(249, initialHeight);
    expect(Number.parseFloat(textarea.style.height)).toBe(initialHeight);
    flushFrames();

    expect(Number.parseFloat(textarea.style.height)).toBe(760);
    expect(textarea).toHaveValue("复".repeat(910));
    expect(onChange).not.toHaveBeenCalled();

    resize(264, 760);
    flushFrames();

    expect(Number.parseFloat(textarea.style.height)).toBe(initialHeight);
  });

  it("does not remeasure repeatedly for height-only observer notifications", () => {
    const { textarea, resize } = renderDescription();
    resize(249, 700);
    flushFrames();
    const countAfterWidthChange = measurements;

    resize(249, 760);
    resize(249, 800);

    expect(frames.size).toBe(0);
    flushFrames();
    expect(measurements).toBe(countAfterWidthChange);
    expect(Number.parseFloat(textarea.style.height)).toBe(760);
  });

  it("coalesces pending width changes before measuring the latest layout", () => {
    const { textarea, resize } = renderDescription();
    resize(249, 700);
    resize(200, 700);

    expect(frames.size).toBe(1);
    flushFrames();

    expect(Number.parseFloat(textarea.style.height)).toBe(920);
    expect(frames.size).toBe(0);
  });

  it("disconnects its observer and cancels pending measurement when the modal input unmounts", () => {
    const { unmount, observer, resize } = renderDescription("");
    resize(249, 20);
    const pendingFrame = [...frames.keys()][0];
    expect(pendingFrame).toBeDefined();
    const countBeforeUnmount = measurements;

    unmount();

    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(pendingFrame);
    expect(frames.size).toBe(0);
    flushFrames();
    expect(measurements).toBe(countBeforeUnmount);
  });
});

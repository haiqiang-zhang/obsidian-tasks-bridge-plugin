import type React from "react";
import { type ChangeEvent, useEffect, useState } from "react";
import { Input, TextField } from "react-aria-components";

type Props = {
  initialValue: number;
  onChange: (val: number) => Promise<void>;
};

export const AutoRefreshIntervalControl: React.FC<Props> = ({ initialValue, onChange }) => {
  const [value, setValue] = useState(`${initialValue}`);

  useEffect(() => {
    setValue(`${initialValue}`);
  }, [initialValue]);

  const onInputChange = (ev: ChangeEvent<HTMLInputElement>) => {
    setValue(ev.target.value);
  };

  const onBlur = async () => {
    if (value.trim().length === 0) {
      setValue(`${initialValue}`);
      return;
    }

    const num = Math.floor(Number(value));
    if (!Number.isFinite(num) || num < 0) {
      setValue(`${initialValue}`);
      return;
    }

    setValue(`${num}`);
    await onChange(num);
  };

  return (
    <TextField aria-label="Auto-refresh interval">
      <Input
        value={value}
        onChange={onInputChange}
        type="number"
        min={0}
        step={1}
        onBlur={() => void onBlur()}
      />
    </TextField>
  );
};

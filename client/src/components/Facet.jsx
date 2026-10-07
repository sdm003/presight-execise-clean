import React from "react";

const Facet = ({ title, items, selected, onToggle }) => (
  <fieldset>
    <legend>
      {title}
      <span>
        {selected.length
          ? `${selected.length} selected`
          : title === "Hobbies"
            ? "Match all"
            : "Match any"}
      </span>
    </legend>

    {[
      ...items,
      ...selected
        .filter((value) => !items.some((item) => item.value === value))
        .map((value) => ({ value, count: 0 })),
    ].map((item) => (
      <label
        className={selected.includes(item.value) ? "checked" : ""}
        key={item.value}
      >
        <input
          type="checkbox"
          checked={selected.includes(item.value)}
          onChange={() => onToggle(item.value)}
        />
        <span>{item.value}</span>
        <b>{item.count}</b>
      </label>
    ))}
  </fieldset>
);

export default Facet;

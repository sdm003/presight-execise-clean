import React from "react";

const Facet = ({ title, items, selected, onToggle }) => (
  <fieldset>
    <legend>
      {title}
      <span>
        {selected.length ? `${selected.length} selected` : "Select any"}
      </span>
    </legend>

    {items.map((item) => (
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

import React from "react";

const Chips = ({ filters, onRemove }) =>
  filters.length > 0 && (
    <div className="chips" aria-label="Active filters">
      {filters.map((filter) => (
        <button
          key={filter.key}
          onClick={() => onRemove(filter.type, filter.label)}
          aria-label={`Remove ${filter.label} filter`}
        >
          {filter.label}
          <span>×</span>
        </button>
      ))}
    </div>
  );

export default Chips;

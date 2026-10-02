import React from "react";

const Toolbar = ({ meta, state, change, clearFilters, hasFilters }) => (
  <div className="toolbar">
    <div>
      <strong>{meta?.total ?? "—"}</strong>
      <span> people found</span>
    </div>
    {hasFilters && (
      <button className="clear" onClick={clearFilters}>
        Clear all
      </button>
    )}
    <div className="sort">
      <label htmlFor="sort">Sort by</label>
      <select
        id="sort"
        value={state.sort}
        onChange={(e) => change({ sort: e.target.value })}
      >
        <option value="first_name">First name</option>
        <option value="last_name">Last name</option>
        <option value="age">Age</option>
        <option value="nationality">Nationality</option>
      </select>
      <button
        className="direction"
        aria-label={`Sort ${state.direction === "asc" ? "descending" : "ascending"}`}
        onClick={() =>
          change({ direction: state.direction === "asc" ? "desc" : "asc" })
        }
      >
        {state.direction === "asc" ? "↑" : "↓"}
      </button>
    </div>
  </div>
);

export default Toolbar;

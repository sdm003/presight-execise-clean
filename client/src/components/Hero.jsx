import React from "react";

const Hero = ({ query, setQuery }) => (
  <header className="hero">
    <div>
      <p className="eyebrow">DIRECTORY</p>
      <h1>Find your people</h1>
      <p className="subtitle">
        Browse a curated community by name, nationality, and interests.
      </p>
    </div>
    <div className="search">
      <span aria-hidden="true">⌕</span>
      <input
        aria-label="Search names"
        placeholder="Search by first or last name…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {query && (
        <button
          className="search-clear"
          aria-label="Clear search"
          onClick={() => setQuery("")}
        >
          ×
        </button>
      )}
    </div>
  </header>
);

export default Hero;

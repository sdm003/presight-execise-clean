import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { changeState, readState } from "./state";
import {
  useDebouncedSearch,
  useInfiniteScroll,
  useUrlSync,
  useUsers,
} from "./hooks";
import Hero from "./components/Hero";
import Toolbar from "./components/Toolbar";
import Chips from "./components/Chips";
import Facet from "./components/Facet";
import Results from "./components/Results";

const App = () => {
  const [state, setState] = useState(readState);
  const change = useCallback(
    (patch) =>
      setState((s) =>
        changeState(s, typeof patch === "function" ? patch(s) : patch),
      ),
    [],
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const sentinel = useRef(null);
  const previousState = useRef(state);
  useLayoutEffect(() => {
    if (previousState.current !== state) {
      const results = document.querySelector(".results");
      if (results && results.getBoundingClientRect().top < 0)
        results.scrollIntoView({ block: "start", behavior: "instant" });
    }
    previousState.current = state;
  }, [state]);

  useUrlSync(state);
  const applySearch = useCallback((search) => change({ search }), [change]);
  const [query, setQuery, setComposing] = useDebouncedSearch(
    state.search,
    applySearch,
  );
  const { users, facets, meta, status, error, page, loadMore, retry } =
    useUsers(state);
  useInfiniteScroll(sentinel, meta?.hasMore && status === "ready", loadMore);

  const toggle = (key, value) =>
    change((s) => ({
      [key]: s[key].includes(value)
        ? s[key].filter((v) => v !== value)
        : [...s[key], value],
    }));
  const clearFilters = () => {
    setQuery("");
    change({ search: "", hobbies: [], nationalities: [] });
  };
  const selectedFilters = [
    ...state.nationalities.map((value) => ({
      key: `nationality-${value}`,
      label: value,
      type: "nationalities",
    })),
    ...state.hobbies.map((value) => ({
      key: `hobby-${value}`,
      label: value,
      type: "hobbies",
    })),
  ];
  const firstLoad = status === "loading" && page === 1 && !users.length;
  const reloading = status === "loading" && page === 1 && users.length > 0;

  return (
    <main>
      <Hero query={query} setQuery={setQuery} setComposing={setComposing} />
      <Toolbar
        meta={meta}
        state={state}
        change={change}
        clearFilters={clearFilters}
        hasFilters={selectedFilters.length > 0 || !!state.search}
      />
      <Chips filters={selectedFilters} onRemove={toggle} />
      <div className="layout">
        <button
          className="filter-toggle"
          aria-expanded={filtersOpen}
          aria-controls="directory-filters"
          onClick={() => setFiltersOpen((open) => !open)}
        >
          Filters{selectedFilters.length ? ` (${selectedFilters.length})` : ""}
        </button>
        <aside
          id="directory-filters"
          className={filtersOpen ? "open" : ""}
          aria-label="Directory filters"
          aria-busy={status === "loading"}
        >
          <Facet
            title="Nationalities"
            items={facets.nationalities}
            selected={state.nationalities}
            onToggle={(v) => toggle("nationalities", v)}
          />
          <Facet
            title="Hobbies"
            items={facets.hobbies}
            selected={state.hobbies}
            onToggle={(v) => toggle("hobbies", v)}
          />
        </aside>
        <Results
          status={status}
          error={error}
          users={users}
          firstLoad={firstLoad}
          reloading={reloading}
          meta={meta}
          page={page}
          sentinel={sentinel}
          retry={retry}
        />
      </div>
    </main>
  );
};

export default App;

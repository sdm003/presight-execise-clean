import React, { useRef, useState } from "react";
import { readState } from "./state";
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
  const change = (patch) => setState((s) => ({ ...s, ...patch }));
  const sentinel = useRef(null);

  useUrlSync(state);
  const [query, setQuery] = useDebouncedSearch(state.search, (applied) =>
    change({ search: applied }),
  );
  const { users, facets, meta, status, error, page, loadMore } =
    useUsers(state);
  useInfiniteScroll(sentinel, meta?.hasMore && status === "ready", loadMore);

  const toggle = (key, value) =>
    change({
      [key]: state[key].includes(value)
        ? state[key].filter((v) => v !== value)
        : [...state[key], value],
    });
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
      <Hero query={query} setQuery={setQuery} />
      <Toolbar
        meta={meta}
        state={state}
        change={change}
        clearFilters={clearFilters}
        hasFilters={selectedFilters.length > 0}
      />
      <Chips filters={selectedFilters} onRemove={toggle} />
      <div className="layout">
        <aside>
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
        />
      </div>
    </main>
  );
};

export default App;

import { useCallback, useEffect, useRef, useState } from "react";
import { api, normalizeSearch, stateParams, writeState } from "./state";
import { validatePage } from "./users.js";
import { clientLog } from "./diagnostics.js";

export const useUrlSync = (state) =>
  useEffect(() => writeState(state), [state]);

export const useDebouncedSearch = (search, onApply, delay = 300) => {
  const [query, setQuery] = useState(search);
  const [composing, setComposing] = useState(false);
  useEffect(() => setQuery(search), [search]);
  useEffect(() => {
    const applied = normalizeSearch(query);
    if (composing || applied === search) return;
    const timer = setTimeout(() => onApply(applied), delay);
    return () => clearTimeout(timer);
  }, [query, search, onApply, delay, composing]);
  return [query, setQuery, setComposing];
};

export const useUsers = (state) => {
  const [users, setUsers] = useState([]);
  const [facets, setFacets] = useState({ hobbies: [], nationalities: [] });
  const [meta, setMeta] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const actions = useRef({});
  const params = stateParams(state);
  params.set("limit", "40");
  const query = params.toString();
  const currentQuery = useRef(query);
  currentQuery.current = query;
  useEffect(() => {
    let active = true;
    let busy = false;
    let failed = false;
    let currentPage = 0;
    let hasMore = false;
    let total;
    let controller;
    const seen = new Set();
    // Guard the render-to-effect gap as well as the cleanup/abort path.
    const isCurrent = () => active && currentQuery.current === query;
    const request = async (nextPage) => {
      if (!isCurrent() || busy) return;
      busy = true;
      failed = false;
      controller = new AbortController();
      setStatus("loading");
      setError("");
      let attempt;
      try {
        for (;;) {
          setPage(nextPage);
          const q = new URLSearchParams(query);
          q.set("page", nextPage);
          attempt = { page: nextPage, started: performance.now() };
          const response = await fetch(`${api}/api/users?${q}`, {
            signal: controller.signal,
          });
          Object.assign(attempt, {
            status: response.status,
            requestId: response.headers.get("X-Request-ID"),
            traceparent: response.headers.get("traceparent"),
          });
          if (!response.ok)
            throw Object.assign(Error(`Request failed (${response.status})`), {
              code: "HTTP_ERROR",
            });
          const body = await response.json();
          if (!isCurrent()) {
            clientLog("users.request.completed", {
              ...attempt,
              outcome: "stale",
            });
            return;
          }
          let data;
          try {
            data = validatePage(body, nextPage, seen);
          } catch (e) {
            if (nextPage === 1 || e.code !== "PAGE_OVERLAP") throw e;
          }
          clientLog("users.request.completed", {
            ...attempt,
            outcome: "success",
          });
          // OFFSET pages can shift between snapshots; restart once, within this request.
          if (nextPage > 1 && (!data || data.pagination.total !== total)) {
            clientLog("users.page.restart", { page: nextPage });
            currentPage = 0;
            hasMore = false;
            seen.clear();
            nextPage = 1;
            continue;
          }
          data.data.forEach((user) => seen.add(user.id));
          setUsers((old) =>
            nextPage === 1 ? data.data : [...old, ...data.data],
          );
          currentPage = nextPage;
          hasMore = data.pagination.hasMore;
          total = data.pagination.total;
          setMeta(data.pagination);
          setFacets(data.facets);
          setStatus("ready");
          break;
        }
      } catch (e) {
        clientLog(
          "users.request.completed",
          {
            ...attempt,
            outcome:
              controller.signal.aborted || e.name === "AbortError"
                ? "cancelled"
                : isCurrent()
                  ? "error"
                  : "stale",
          },
          e,
        );
        if (isCurrent() && e.name !== "AbortError") {
          failed = true;
          setError(e.message);
          setStatus("error");
        }
      } finally {
        busy = false;
      }
    };
    actions.current = {
      loadMore: () => {
        if (hasMore && !failed) void request(currentPage + 1);
      },
      retry: () => {
        clientLog("users.request.retry", { page: currentPage + 1 });
        void request(currentPage + 1);
      },
    };
    void request(1);
    return () => {
      active = false;
      controller?.abort();
    };
  }, [query]);
  const loadMore = useCallback(() => actions.current.loadMore?.(), []);
  const retry = useCallback(() => actions.current.retry?.(), []);
  return { users, facets, meta, status, error, page, loadMore, retry };
};

export const useInfiniteScroll = (ref, enabled, onLoadMore) => {
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && enabled) onLoadMore();
      },
      { rootMargin: "500px" },
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref, enabled, onLoadMore]);
};

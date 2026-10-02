import {useCallback, useEffect, useState} from 'react';
import {api, normalizeSearch, writeState} from './state';

export const useUrlSync = state => useEffect(() => writeState(state), [state]);

export const useDebouncedSearch = (search, onApply, delay = 300) => {
    const [query, setQuery] = useState(search);
    useEffect(() => setQuery(search), [search]);
    useEffect(() => {
        const applied = normalizeSearch(query);
        if (applied === search) return;
        const timer = setTimeout(() => onApply(applied), delay);
        return () => clearTimeout(timer);
    }, [query]);
    return [query, setQuery];
};

export const useUsers = state => {
    const [users, setUsers] = useState([]);
    const [facets, setFacets] = useState({hobbies: [], nationalities: []});
    const [meta, setMeta] = useState(null);
    const [status, setStatus] = useState('loading');
    const [error, setError] = useState('');
    const [page, setPage] = useState(1);
    useEffect(() => setPage(1), [state]);
    useEffect(() => {
        let cancelled = false;
        const controller = new AbortController();
        setStatus('loading');
        setError('');
        const q = new URLSearchParams({
            ...state,
            page,
            limit: 40,
            nationalities: state.nationalities.join(','),
            hobbies: state.hobbies.join(',')
        });
        delete q.search;
        if (state.search) q.set('search', state.search);
        fetch(`${api}/api/users?${q}`, {signal: controller.signal}).then(async response => {
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw Error(data.error || 'Request failed');
            return data;
        }).then(data => {
            if (cancelled) return;
            setUsers(old => page === 1 ? data.data : [...old, ...data.data]);
            setMeta(data.pagination);
            setFacets(data.facets);
            setStatus('ready');
        }).catch(e => {
            if (!cancelled && e.name !== 'AbortError') {
                setError(e.message);
                setStatus('error');
            }
        });
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [state, page]);
    const loadMore = useCallback(() => {
        setStatus('loading');
        setPage(current => current + 1);
    }, []);
    return {users, facets, meta, status, error, page, loadMore};
};

export const useInfiniteScroll = (ref, enabled, onLoadMore) => {
    useEffect(() => {
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting && enabled) onLoadMore();
        }, {rootMargin: '500px'});
        if (ref.current) observer.observe(ref.current);
        return () => observer.disconnect();
    }, [ref, enabled, onLoadMore]);
};

import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const api = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:3001' : '');
const validSorts = ['first_name', 'last_name', 'age', 'nationality'];
const normalizeSearch = value => value.replace(/\s+/g, ' ').trim().slice(0, 100);
const readState = () => {
  const q = new URLSearchParams(location.search);
  const sort = q.get('sort');
  return {
    search: normalizeSearch(q.get('search') || ''),
    hobbies: [...new Set(q.getAll('hobby').filter(Boolean))].slice(0, 20),
    nationalities: [...new Set(q.getAll('nationality').filter(Boolean))].slice(0, 20),
    sort: validSorts.includes(sort) ? sort : 'first_name',
    direction: q.get('direction') === 'desc' ? 'desc' : 'asc'
  };
};
const writeState = state => {
  const q = new URLSearchParams();
  if (state.search) q.set('search', state.search);
  state.hobbies.forEach(v => q.append('hobby', v)); state.nationalities.forEach(v => q.append('nationality', v));
  q.set('sort', state.sort); q.set('direction', state.direction); history.replaceState(null, '', `?${q.toString().replace(/\+/g, '%20')}`);
};

function App() {
  const [state, setState] = useState(readState), [users, setUsers] = useState([]), [facets, setFacets] = useState({ hobbies: [], nationalities: [] });
  const [page, setPage] = useState(1), [meta, setMeta] = useState(null), [status, setStatus] = useState('loading'), [error, setError] = useState('');
  const [query, setQuery] = useState(state.search);
  const sentinel = useRef(null);
  const change = patch => setState(s => ({ ...s, ...patch }));
  useEffect(() => setQuery(state.search), [state.search]);
  useEffect(() => {
    const applied = normalizeSearch(query);
    if (applied === state.search) return;
    const timer = setTimeout(() => change({ search: applied }), 300);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => { writeState(state); setPage(1); }, [state]);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setStatus('loading'); setError('');
    const q = new URLSearchParams({ ...state, page, limit: 40, nationalities: state.nationalities.join(','), hobbies: state.hobbies.join(',') }); delete q.search; if (state.search) q.set('search', state.search);
    fetch(`${api}/api/users?${q}`, { signal: controller.signal }).then(async response => {
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
      if (!cancelled && e.name !== 'AbortError') { setError(e.message); setStatus('error'); }
    });
    return () => { cancelled = true; controller.abort(); };
  }, [state, page]);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && meta?.hasMore && status === 'ready') {
        setStatus('loading');
        setPage(current => current + 1);
      }
    }, { rootMargin: '500px' });
    if (sentinel.current) observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [meta, status]);
  const toggle = (key, value) => change({ [key]: state[key].includes(value) ? state[key].filter(v => v !== value) : [...state[key], value] });
  const clearFilters = () => { setQuery(''); change({ search: '', hobbies: [], nationalities: [] }); };
  const selectedFilters = [...state.nationalities.map(value => ({ key: `nationality-${value}`, label: value, type: 'nationalities' })), ...state.hobbies.map(value => ({ key: `hobby-${value}`, label: value, type: 'hobbies' }))];
  const firstLoad = status === 'loading' && page === 1 && !users.length;
  const reloading = status === 'loading' && page === 1 && users.length > 0;
  return <main>
    <header className="hero">
      <div><p className="eyebrow">DIRECTORY</p><h1>Find your people</h1><p className="subtitle">Browse a curated community by name, nationality, and interests.</p></div>
      <div className="search"><span aria-hidden="true">⌕</span><input aria-label="Search names" placeholder="Search by first or last name…" value={query} onChange={e => setQuery(e.target.value)} />{query && <button className="search-clear" aria-label="Clear search" onClick={() => setQuery('')}>×</button>}</div>
    </header>
    <div className="toolbar">
      <div><strong>{meta?.total ?? '—'}</strong><span> people found</span></div>
      {selectedFilters.length > 0 && <button className="clear" onClick={clearFilters}>Clear all</button>}
      <div className="sort"><label htmlFor="sort">Sort by</label><select id="sort" value={state.sort} onChange={e => change({ sort: e.target.value })}><option value="first_name">First name</option><option value="last_name">Last name</option><option value="age">Age</option><option value="nationality">Nationality</option></select><button className="direction" aria-label={`Sort ${state.direction === 'asc' ? 'descending' : 'ascending'}`} onClick={() => change({ direction: state.direction === 'asc' ? 'desc' : 'asc' })}>{state.direction === 'asc' ? '↑' : '↓'}</button></div>
    </div>
    {selectedFilters.length > 0 && <div className="chips" aria-label="Active filters">{selectedFilters.map(filter => <button key={filter.key} onClick={() => toggle(filter.type, filter.label)}>{filter.label} <span>×</span></button>)}</div>}
    <div className="layout"><aside>
      <Facet title="Nationalities" items={facets.nationalities} selected={state.nationalities} onToggle={v => toggle('nationalities', v)} />
      <Facet title="Hobbies" items={facets.hobbies} selected={state.hobbies} onToggle={v => toggle('hobbies', v)} />
    </aside><section className="results">
      {status === 'error' && <div className="message error"><strong>We couldn't load the directory.</strong><span>{error}</span><button onClick={() => window.location.reload()}>Try again</button></div>}
      {status === 'ready' && !users.length && <p className="message">No people match these filters.</p>}
      {firstLoad && <div className="cards">{Array.from({ length: 12 }, (_, i) => <div className="card skeleton" key={i}><div className="s-avatar" /><div className="card-body"><div className="s-line s-name" /><div className="s-line s-sub" /><div className="s-tags"><span /><span /></div></div></div>)}</div>}
      <div className={`cards${reloading ? ' reloading' : ''}`}>{users.map(user => <article className="card" key={user.id}><img src={user.avatar} alt="" loading="lazy" /><div className="card-body"><div className="card-heading"><h2>{user.first_name} {user.last_name}</h2><span className="age">{user.age}</span></div><p className="location">{user.nationality}</p><div className="hobbies">{user.hobbies.slice(0, 2).map(hobby => <span key={hobby}>{hobby}</span>)}{user.hobbies.length > 2 && <span className="more">+{user.hobbies.length - 2}</span>}</div></div></article>)}</div>
      <div ref={sentinel} className="sentinel" aria-live="polite">{status === 'loading' && page > 1 ? 'Loading more…' : meta && users.length ? `${users.length} of ${meta.total}` : ''}</div>
    </section></div>
  </main>;
}
function Facet({ title, items, selected, onToggle }) { return <fieldset><legend>{title}<span>{selected.length ? `${selected.length} selected` : 'Select any'}</span></legend>{items.map(item => <label className={selected.includes(item.value) ? 'checked' : ''} key={item.value}><input type="checkbox" checked={selected.includes(item.value)} onChange={() => onToggle(item.value)} /> <span>{item.value}</span><b>{item.count}</b></label>)}</fieldset>; }
createRoot(document.getElementById('root')).render(<App />);

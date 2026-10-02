import React from 'react';
import UserCard from './UserCard';

const Skeletons = () => <div className="cards">{Array.from({length: 12}, (_, i) => <div className="card skeleton"
                                                                                        key={i}>
    <div className="s-avatar"/>
    <div className="card-body">
        <div className="s-line s-name"/>
        <div className="s-line s-sub"/>
        <div className="s-tags"><span/><span/></div>
    </div>
</div>)}</div>;

const Results = ({status, error, users, firstLoad, reloading, meta, page, sentinel}) => <section className="results">
    {status === 'error' &&
        <div className="message error"><strong>We couldn't load the directory.</strong><span>{error}</span>
            <button onClick={() => window.location.reload()}>Try again</button>
        </div>}
    {status === 'ready' && !users.length && <p className="message">No people match these filters.</p>}
    {firstLoad && <Skeletons/>}
    <div className={`cards${reloading ? ' reloading' : ''}`}>{users.map(user => <UserCard key={user.id} user={user}/>)}</div>
    <div ref={sentinel} className="sentinel"
         aria-live="polite">{status === 'loading' && page > 1 ? 'Loading more…' : meta && users.length ? `${users.length} of ${meta.total}` : ''}</div>
</section>;

export default Results;

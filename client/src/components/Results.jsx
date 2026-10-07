import React, { memo, useLayoutEffect, useRef, useState } from "react";
import UserCard from "./UserCard";
import { CARD_HEIGHT, GAP, rowWindow } from "../virtual.js";

const VirtualCards = ({ users, reloading }) => {
  const ref = useRef(null);
  const [view, setView] = useState(() => ({
    ...rowWindow(users.length, 1, 0, 0, innerHeight),
    columns: 1,
  }));
  useLayoutEffect(() => {
    const node = ref.current;
    let frame = null;
    let layoutChanged = true;
    let columns = 1;
    let offset = 0;
    let previousWindow;
    const measure = () => {
      frame = null;
      if (layoutChanged) {
        columns = getComputedStyle(node).gridTemplateColumns.split(" ").length;
        offset = node.getBoundingClientRect().top + scrollY;
        layoutChanged = false;
      }
      const next = {
        ...rowWindow(users.length, columns, scrollY, offset, innerHeight),
        columns,
      };
      if (
        previousWindow &&
        Object.keys(next).every((key) => previousWindow[key] === next[key])
      )
        return;
      previousWindow = next;
      setView(next);
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(measure);
    };
    const scheduleLayout = () => {
      layoutChanged = true;
      schedule();
    };
    const observer = new ResizeObserver(scheduleLayout);
    observer.observe(node);
    observer.observe(document.body);
    addEventListener("scroll", schedule, { passive: true });
    addEventListener("resize", scheduleLayout);
    measure();
    return () => {
      observer.disconnect();
      removeEventListener("scroll", schedule);
      removeEventListener("resize", scheduleLayout);
      cancelAnimationFrame(frame);
    };
  }, [users.length]);
  return (
    <div
      ref={ref}
      className={`cards virtual-cards${reloading ? " reloading" : ""}`}
      style={{
        height: view.height,
        "--card-height": `${CARD_HEIGHT}px`,
        "--card-gap": `${GAP}px`,
      }}
    >
      <div
        className="cards virtual-window"
        style={{
          top: view.top,
          gridTemplateColumns: `repeat(${view.columns}, minmax(0, 1fr))`,
        }}
      >
        {users.slice(view.start, view.end).map((user) => (
          <UserCard key={user.id} user={user} />
        ))}
      </div>
    </div>
  );
};

const Skeletons = () => (
  <div className="cards" aria-hidden="true">
    {Array.from({ length: 12 }, (_, i) => (
      <div className="card skeleton" key={i}>
        <div className="s-avatar" />
        <div className="card-body">
          <div className="s-line s-name" />
          <div className="s-line s-sub" />
          <div className="s-tags">
            <span />
            <span />
          </div>
        </div>
      </div>
    ))}
  </div>
);

const Results = ({
  status,
  error,
  users,
  firstLoad,
  reloading,
  meta,
  page,
  sentinel,
  retry,
}) => (
  <section
    className="results"
    aria-label="Directory results"
    aria-busy={status === "loading"}
  >
    {status === "error" && (
      <div className="message error" role="alert">
        <strong>We couldn't load the directory.</strong>
        <span>{error}</span>
        <button onClick={retry}>Try again</button>
      </div>
    )}
    {status === "ready" && !users.length && (
      <p className="message">No people match these filters.</p>
    )}
    {firstLoad && <Skeletons />}
    {!!users.length && <VirtualCards users={users} reloading={reloading} />}
    <div ref={sentinel} className="sentinel" role="status">
      {status === "loading"
        ? page > 1
          ? "Loading more…"
          : "Loading people…"
        : meta && users.length
          ? `${users.length} of ${meta.total}`
          : ""}
    </div>
  </section>
);

export default memo(Results);

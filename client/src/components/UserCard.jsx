import React, { memo } from "react";

const UserCard = ({ user }) => (
  <article className="card" data-user-id={user.id}>
    <img
      src={user.avatar}
      alt=""
      loading="lazy"
      decoding="async"
      width="58"
      height="58"
      referrerPolicy="no-referrer"
    />
    <div className="card-body">
      <div className="card-heading">
        <h2 title={`${user.first_name} ${user.last_name}`}>
          {user.first_name} {user.last_name}
        </h2>
      </div>
      <p className="location">
        <span title={user.nationality}>{user.nationality}</span>
        <span className="age" aria-label={`Age ${user.age}`}>
          {user.age}
        </span>
      </p>
      <div className="hobbies">
        {user.hobbies.slice(0, 2).map((hobby) => (
          <span key={hobby} title={hobby}>
            {hobby}
          </span>
        ))}
        {user.hobbies.length > 2 && (
          <span
            className="more"
            title={user.hobbies.slice(2).join(", ")}
            aria-label={`${user.hobbies.length - 2} more hobbies: ${user.hobbies.slice(2).join(", ")}`}
          >
            +{user.hobbies.length - 2}
          </span>
        )}
      </div>
    </div>
  </article>
);

export default memo(UserCard);

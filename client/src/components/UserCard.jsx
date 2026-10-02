import React from "react";

const UserCard = ({ user }) => (
  <article className="card">
    <img src={user.avatar} alt="" loading="lazy" />
    <div className="card-body">
      <div className="card-heading">
        <h2>
          {user.first_name} {user.last_name}
        </h2>
        <span className="age">{user.age}</span>
      </div>
      <p className="location">{user.nationality}</p>
      <div className="hobbies">
        {user.hobbies.slice(0, 2).map((hobby) => (
          <span key={hobby}>{hobby}</span>
        ))}
        {user.hobbies.length > 2 && (
          <span className="more">+{user.hobbies.length - 2}</span>
        )}
      </div>
    </div>
  </article>
);

export default UserCard;

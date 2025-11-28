function ParticipantList({ participants, selfId }) {
  return (
    <aside className="sidebar sidebar--participants">
      <div className="sidebar__header">
        <h2>People</h2>
        <span>{participants.length}</span>
      </div>
      <ul className="sidebar__list">
        {participants.map((p) => (
          <li
            key={p.id}
            className={`sidebar__item ${
              p.id === selfId ? 'sidebar__item--self' : ''
            }`}
          >
            <div className="sidebar__avatar">
              {p.name?.[0]?.toUpperCase() || '?'}
            </div>
            <div className="sidebar__info">
              <div className="sidebar__name">
                {p.name}
                {p.id === selfId && <span className="tag">You</span>}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}

export default ParticipantList;

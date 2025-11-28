import { useRef } from 'react';

function VideoTile({ name, stream, isLocal, x, y, onPointerDown, setVolume }) {
  const volumeRef = useRef(1);

  return (
    <div
      className="tile"
      style={{ transform: `translate(${x}px, ${y}px)` }}
      onPointerDown={onPointerDown}
    >
      <div className="tile__video">
        {stream ? (
          <video
            ref={(node) => {
              if (node && stream) {
                if (node.srcObject !== stream) node.srcObject = stream;
                node.muted = isLocal;
                if (setVolume) {
                  setVolume(node);
                  volumeRef.current = node.volume;
                } else {
                  node.volume = volumeRef.current;
                }
                node.play().catch(() => {});
              }
            }}
            playsInline
            autoPlay
          />
        ) : (
          <div className="tile__placeholder">No video</div>
        )}
      </div>
      <div className="tile__name">
        {name}
        {isLocal && <span className="tile__badge">You</span>}
      </div>
    </div>
  );
}

export default VideoTile;

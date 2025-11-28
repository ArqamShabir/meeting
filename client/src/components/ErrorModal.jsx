function ErrorModal({ message, onClose }) {
  if (!message) return null;
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal__title">Oops</div>
        <div className="modal__body">{message}</div>
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

export default ErrorModal;

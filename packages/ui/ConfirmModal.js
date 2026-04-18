'use client';
import { Modal } from './Modal.js';

export function ConfirmModal({ message, ...props }) {
  return (
    <Modal {...props}>
      <p style={{ margin: 0, lineHeight: 1.5 }}>{message}</p>
    </Modal>
  );
}

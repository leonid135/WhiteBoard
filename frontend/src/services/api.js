export const createSession = async (whiteboardId = null, name = 'Новая доска') => {
  const response = await fetch(`${API_BASE}/sessions/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ whiteboard_id: whiteboardId, name }),
  });
  if (!response.ok) throw new Error('Failed to create session');
  return response.json();
};

export const getWhiteboard = async (id) => {
  const response = await fetch(`${API_BASE}/whiteboards/${id}/`);
  if (!response.ok) throw new Error('Failed to fetch whiteboard');
  return response.json();
};

export const exportPDF = async (id) => {
  window.open(`${API_BASE}/whiteboards/${id}/export_pdf/`);
};
export const API_BASE = 'http://localhost:8000/api';

export const exportLatexWithImages = async (id) => {
  window.open(`${API_BASE}/whiteboards/${id}/export_latex_with_images/`);
};
class WhiteboardWebSocket {
  constructor(roomId, onMessage) {
    console.log('Creating WebSocket for room:', roomId);
    this.socket = new WebSocket(`ws://localhost:8000/ws/whiteboard/${roomId}/`);

    this.socket.onopen = () => {
      console.log('WebSocket connected, readyState:', this.socket.readyState);
    };

    this.socket.onerror = (error) => {
      console.error('WebSocket error:', error, 'readyState:', this.socket.readyState);
    };

    this.socket.onclose = (event) => {
      console.log('WebSocket disconnected, code:', event.code, 'reason:', event.reason, 'wasClean:', event.wasClean);
    };

    this.socket.onmessage = (e) => {
      console.log('WebSocket message received, data length:', e.data.length);
      try {
        const data = JSON.parse(e.data);
        console.log('Parsed message:', data);
        onMessage(data);
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err, e.data);
      }
    };
  }

  send(data) {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(data));
    } else {
      console.warn('WebSocket not open, readyState:', this.socket.readyState);
    }
  }

  close() {
    console.log('Closing WebSocket');
    this.socket.close();
  }
}

export default WhiteboardWebSocket;
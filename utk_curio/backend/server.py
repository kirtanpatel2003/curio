import os
from utk_curio.backend.app import create_app
from utk_curio.backend.extensions import socketio

app = create_app()

@app.route('/health', methods=['GET'])
def health():
    return 'OK', 200

if __name__ == '__main__':
    socketio.run(
        app,
        host=os.getenv('FLASK_BACKEND_HOST', 'localhost'),
        port=int(os.getenv('FLASK_BACKEND_PORT', 5002)),
        debug=True,
        allow_unsafe_werkzeug=True,
    )


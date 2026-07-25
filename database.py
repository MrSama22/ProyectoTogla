import sqlite3
import numpy as np
import io

def adapt_array(arr):
    """
    Serializa un array NumPy de 128 dimensiones para guardarlo en SQLite.
    """
    out = io.BytesIO()
    np.save(out, arr)
    out.seek(0)
    return sqlite3.Binary(out.read())

def convert_array(text):
    """
    Deserializa el BLOB de SQLite a un array NumPy.
    """
    out = io.BytesIO(text)
    out.seek(0)
    return np.load(out)

# Registrar adaptadores en sqlite3 para manejar arrays de numpy automáticamente
sqlite3.register_adapter(np.ndarray, adapt_array)
sqlite3.register_converter("array", convert_array)

def init_db(db_name="antigravity.db"):
    """
    Inicializa la base de datos y crea la tabla estudiantes si no existe.
    """
    conn = sqlite3.connect(db_name, detect_types=sqlite3.PARSE_DECLTYPES)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS estudiantes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL,
            qr_data TEXT UNIQUE NOT NULL,
            face_encoding array NOT NULL
        )
    ''')
    conn.commit()
    conn.close()

def get_student_by_qr(qr_data, db_name="antigravity.db"):
    """
    Busca un estudiante por los datos de su código QR.
    Retorna (nombre, face_encoding) o None si no existe.
    """
    conn = sqlite3.connect(db_name, detect_types=sqlite3.PARSE_DECLTYPES)
    cursor = conn.cursor()
    cursor.execute('SELECT nombre, face_encoding FROM estudiantes WHERE qr_data = ?', (qr_data,))
    result = cursor.fetchone()
    conn.close()
    return result

def get_all_students(db_name="antigravity.db"):
    """
    Retorna todos los estudiantes en la base de datos.
    Lista de tuplas: (qr_data, nombre, face_encoding)
    """
    conn = sqlite3.connect(db_name, detect_types=sqlite3.PARSE_DECLTYPES)
    cursor = conn.cursor()
    cursor.execute('SELECT qr_data, nombre, face_encoding FROM estudiantes')
    results = cursor.fetchall()
    conn.close()
    return results

def insert_student(nombre, qr_data, face_encoding, db_name="antigravity.db"):
    """
    Inserta un nuevo estudiante en la base de datos.
    """
    conn = sqlite3.connect(db_name, detect_types=sqlite3.PARSE_DECLTYPES)
    cursor = conn.cursor()
    try:
        cursor.execute('INSERT INTO estudiantes (nombre, qr_data, face_encoding) VALUES (?, ?, ?)',
                       (nombre, qr_data, face_encoding))
        conn.commit()
        success = True
    except sqlite3.IntegrityError:
        success = False # Probablemente el QR ya existe
    finally:
        conn.close()
    return success

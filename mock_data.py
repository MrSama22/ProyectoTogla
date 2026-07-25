import face_recognition
from database import init_db, insert_student

def inject_mock_student(image_path, nombre, qr_data):
    """
    Inyecta un estudiante de prueba en la base de datos a partir de una imagen.
    """
    print(f"Generando encoding para {nombre}...")
    try:
        # Cargar la imagen del estudiante
        image = face_recognition.load_image_file(image_path)
        
        # Detectar el encoding (asumimos que hay un rostro claro en la imagen)
        encodings = face_recognition.face_encodings(image)
        
        if len(encodings) > 0:
            face_encoding = encodings[0]
            # Inicializar la DB por si acaso
            init_db()
            
            # Insertar en la base de datos
            success = insert_student(nombre, qr_data, face_encoding)
            if success:
                print(f"✅ Estudiante '{nombre}' (QR: {qr_data}) insertado correctamente en antigravity.db")
            else:
                print(f"⚠️ Error al insertar: El QR '{qr_data}' probablemente ya existe en la base de datos.")
        else:
            print("❌ Error: No se detectó ningún rostro en la imagen proporcionada. Intenta con una foto más clara.")
            
    except FileNotFoundError:
        print(f"❌ Error: No se encontró la imagen '{image_path}'. Asegúrate de que exista en la carpeta.")

if __name__ == "__main__":
    # INSTRUCCIONES:
    # 1. Coloca una foto tuya o de prueba en la misma carpeta (ej: "foto_prueba.jpg")
    # 2. Reemplaza los datos abajo con tus datos de prueba.
    
    print("Iniciando inyección de datos de prueba...")
    # Descomenta y edita la siguiente línea cuando tengas tu foto lista:
     
    inject_mock_student("foto_prueba.jpeg", "Jhulian", "QR12345")
    
    print("⚠️ Por favor edita el script 'mock_data.py' para incluir el nombre de una imagen real y descomentar la línea de ejecución.")

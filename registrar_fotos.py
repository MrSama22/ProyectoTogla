import os
import face_recognition
from database import init_db, insert_student

def registrar_desde_carpeta(carpeta_imagenes="."):
    # Inicializar DB
    init_db()
    
    # Buscar fotos directamente en la carpeta seleccionada (actual por defecto)
    archivos = [f for f in os.listdir(carpeta_imagenes) if f.lower().endswith(('.png', '.jpg', '.jpeg'))]
    
    if not archivos:
        print("No encontré imágenes (.jpg o .png) sueltas en esta carpeta.")
        return
        
    print(f"Se encontraron {len(archivos)} imágenes. Iniciando procesamiento...\n")
    
    registrados = 0
    errores = 0
    
    for archivo in archivos:
        ruta = os.path.join(carpeta_imagenes, archivo)
        # Usar el nombre del archivo (sin la extensión) como el código QR y Nombre
        qr_data = os.path.splitext(archivo)[0] 
        nombre = f"Estudiante_{qr_data}"
        
        print(f"Procesando: {archivo} ...", end=" ")
        
        try:
            # Cargar imagen
            imagen = face_recognition.load_image_file(ruta)
            
            # Buscar rostros
            face_locations = face_recognition.face_locations(imagen)
            
            if not face_locations:
                print("❌ ERROR: No se detectó ningún rostro en la foto.")
                errores += 1
                continue
                
            # Extraer las medidas del rostro (usamos el primero que encuentre)
            face_encoding = face_recognition.face_encodings(imagen, face_locations)[0]
            
            # Guardar en base de datos
            exito = insert_student(nombre, qr_data, face_encoding)
            
            if exito:
                print("✅ REGISTRADO con éxito.")
                registrados += 1
            else:
                print("⚠️ Ya estaba registrado en la base de datos.")
                
        except Exception as e:
            print(f"❌ ERROR al procesar la imagen: {e}")
            errores += 1
            
    print("\n" + "="*40)
    print(f" RESUMEN: {registrados} registrados | {errores} fallaron")
    print("="*40)

if __name__ == '__main__':
    registrar_desde_carpeta()

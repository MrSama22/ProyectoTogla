import cv2
from pyzbar.pyzbar import decode, ZBarSymbol
import face_recognition
import numpy as np
import time
import json
import base64
import os
import re
from database import init_db, insert_student

def cargar_estudiantes_oficiales():
    ruta = os.path.join(os.path.dirname(__file__), "estudiantes.json")
    if not os.path.exists(ruta):
        return {}
    try:
        with open(ruta, "r", encoding="utf-8") as f:
            datos = json.load(f)
        return {str(d["documento"]).strip(): d for d in datos if "documento" in d}
    except Exception as e:
        print(f"Advertencia: no se pudo cargar estudiantes.json: {e}")
        return {}

def buscar_estudiante_oficial(codigo_raw, mapa_estudiantes):
    if not codigo_raw:
        return None
    codigo = str(codigo_raw).strip()
    if codigo in mapa_estudiantes:
        return mapa_estudiantes[codigo]
    
    # URL con parametro codigo (ej. boletines)
    match = re.search(r'[?&]codigo=([^&]+)', codigo)
    if match:
        import urllib.parse
        param = urllib.parse.unquote(match.group(1))
        try:
            b64 = base64.b64decode(param).decode('utf-8', errors='ignore').strip()
            if b64 in mapa_estudiantes:
                return mapa_estudiantes[b64]
        except Exception:
            pass
        if param in mapa_estudiantes:
            return mapa_estudiantes[param]
            
    # Base64 directo
    try:
        b64 = base64.b64decode(codigo).decode('utf-8', errors='ignore').strip()
        if b64 in mapa_estudiantes:
            return mapa_estudiantes[b64]
    except Exception:
        pass
        
    # Secuencia de 10 digitos
    diez = re.search(r'\b\d{10}\b', codigo)
    if diez and diez.group(0) in mapa_estudiantes:
        return mapa_estudiantes[diez.group(0)]
        
    return None

def registrar_desde_camara():
    # Inicializamos la base de datos
    init_db()
    
    mapa_estudiantes = cargar_estudiantes_oficiales()
    print(f"Base de datos oficial cargada: {len(mapa_estudiantes)} estudiantes.")
    
    cap = cv2.VideoCapture("http://192.168.1.37:4747/video")
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1) # <--- OPTIMIZACIÓN: Evita el delay/lag de DroidCam
    
    print("=========================================")
    print(" MODO DE REGISTRO AUTOMÁTICO INICIADO")
    print("=========================================")
    print("Instrucciones:")
    print("1. Muestra el carnet (código QR) a la cámara.")
    print("2. Tienes 30 segundos para mostrar tu rostro.")
    print("El sistema te registrará automáticamente.")
    print("Presiona 'q' para salir.")
    print("=========================================\n")

    qr_activo = None
    tiempo_qr = 0
    TIEMPO_ESPERA = 30 # Segundos para mostrar el rostro tras leer el QR
    
    ultimo_chequeo_rostro = 0
    capturas_realizadas = 0
    encodings_temporales = []
    
    mensaje_feedback = ""
    color_feedback = (0, 255, 0)

    while True:
        ret, frame = cap.read()
        if not ret:
            break
            
        gray_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        
        # 1. Buscar códigos QR
        qrs_detectados = decode(gray_frame, symbols=[ZBarSymbol.QRCODE])
        
        # UI
        cv2.putText(frame, "MODO REGISTRO", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 0, 0), 2)
        
        # Si vemos un QR y no estamos a mitad de una captura múltiple, lo guardamos
        if qrs_detectados and capturas_realizadas == 0:
            for qr in qrs_detectados:
                qr_data = qr.data.decode('utf-8')
                
                pts = np.array([qr.polygon], np.int32).reshape((-1, 1, 2))
                cv2.polylines(frame, [pts], True, (255, 0, 255), 2)
                
                qr_activo = qr_data
                estudiante_actual = buscar_estudiante_oficial(qr_activo, mapa_estudiantes)
                tiempo_qr = time.time()
                capturas_realizadas = 0
                encodings_temporales = []

        # 2. Si tenemos un QR en memoria reciente, buscamos el rostro
        if qr_activo and (time.time() - tiempo_qr < TIEMPO_ESPERA):
            tiempo_transcurrido = time.time() - tiempo_qr
            
            # Dibujar datos del estudiante reconocido por QR
            if estudiante_actual:
                cv2.putText(frame, f"{estudiante_actual['nombre']} ({estudiante_actual['grado']}-{estudiante_actual['grupo']})", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
            
            # Dibujar mensajes persistentes de feedback
            cv2.putText(frame, mensaje_feedback, (20, 130), cv2.FONT_HERSHEY_SIMPLEX, 0.8, color_feedback, 2)
            
            # FASE DE CAPTURA
            if capturas_realizadas > 0:
                cv2.putText(frame, f"Capturando foto... {capturas_realizadas}/3", (20, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
                cv2.putText(frame, "Mantenga su rostro quieto y centrado", (20, 90), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
            else:
                segundos_restantes = int(TIEMPO_ESPERA - tiempo_transcurrido)
                cv2.putText(frame, "Acomódese para la foto...", (20, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)
                cv2.putText(frame, f"Tiempo límite para registro: {segundos_restantes}s", (20, 90), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
                
            # Solo ejecutamos el reconocimiento pesado 1 vez por segundo
            if time.time() - ultimo_chequeo_rostro > 1.0:
                ultimo_chequeo_rostro = time.time()
                
                rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                face_locations = face_recognition.face_locations(rgb_frame)
                
                if not face_locations:
                    mensaje_feedback = "⚠️ No se detecta rostro. Mire a la camara."
                    color_feedback = (0, 0, 255) # Rojo
                else:
                    # Validar tamaño del rostro
                    top, right, bottom, left = face_locations[0]
                    face_width = right - left
                    
                    min_w = frame.shape[1] * 0.15 # Al menos 15% de la pantalla de ancho
                    max_w = frame.shape[1] * 0.65 # Máximo 65% de la pantalla de ancho
                    
                    # Mostrar el recuadro para feedback visual en todo momento
                    cv2.rectangle(frame, (left, top), (right, bottom), (255, 255, 0), 2)
                    
                    if face_width < min_w:
                        mensaje_feedback = "⚠️ Acercate un poco mas a la camara."
                        color_feedback = (0, 165, 255) # Naranja
                    elif face_width > max_w:
                        mensaje_feedback = "⚠️ Alejate un poco de la camara."
                        color_feedback = (0, 165, 255) # Naranja
                    else:
                        mensaje_feedback = "✅ Rostro en posicion perfecta."
                        color_feedback = (0, 255, 0) # Verde
                        
                        # ¡La posición es buena! CAPTURAMOS (Ya no hay que esperar los 3s de preparación)
                        face_encodings = face_recognition.face_encodings(rgb_frame, face_locations)
                        
                        if len(face_encodings) > 0:
                            face_encoding = face_encodings[0]
                            
                            # Guardar temporalmente
                            encodings_temporales.append(face_encoding)
                            capturas_realizadas += 1
                            
                            # Guardar la foto en disco
                            import os
                            if not os.path.exists("fotos_registradas"):
                                os.makedirs("fotos_registradas")
                            cv2.imwrite(f"fotos_registradas/{qr_activo}_{capturas_realizadas}.jpg", frame)
                            
                            # Si ya tenemos 3 capturas, guardamos en la base de datos
                            if capturas_realizadas >= 3:
                                # PROMEDIAR LOS 3 ROSTROS PARA MAYOR PRECISIÓN
                                avg_encoding = np.mean(encodings_temporales, axis=0)
                                
                                nombre_guardar = estudiante_actual["nombre"] if estudiante_actual else f"Estudiante_{qr_activo}"
                                grado_guardar = estudiante_actual["grado"] if estudiante_actual else None
                                grupo_guardar = estudiante_actual["grupo"] if estudiante_actual else None
                                
                                success = insert_student(nombre_guardar, qr_activo, avg_encoding, grado=grado_guardar, grupo=grupo_guardar)
                                
                                if success:
                                    grado_info = f" ({grado_guardar}-{grupo_guardar})" if grado_guardar is not None else ""
                                    print(f"¡ÉXITO! {nombre_guardar}{grado_info} registrado con el QR: {qr_activo}")
                                    cv2.rectangle(frame, (0, 0), (frame.shape[1], frame.shape[0]), (0, 255, 0), 10)
                                    cv2.putText(frame, "¡REGISTRO EXITOSO!", (50, frame.shape[0]//2 - 30), cv2.FONT_HERSHEY_DUPLEX, 1.2, (0, 255, 0), 2)
                                    cv2.putText(frame, f"{nombre_guardar}{grado_info}", (50, frame.shape[0]//2 + 20), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
                                    cv2.imshow('Registro', frame)
                                    cv2.waitKey(2000) 
                                else:
                                    cv2.putText(frame, "Error: QR ya registrado", (left, top - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)
                                
                                # Limpiamos memoria tras registrar
                                qr_activo = None
                                estudiante_actual = None
                                capturas_realizadas = 0
                                encodings_temporales = []
                                mensaje_feedback = ""
        else:
            qr_activo = None # Limpiar por timeout
            estudiante_actual = None
            capturas_realizadas = 0
            encodings_temporales = []
            cv2.putText(frame, "Muestre un QR para registrar", (50, frame.shape[0] - 50), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (200, 200, 200), 2)

        cv2.imshow('Registro', frame)
        
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break
            
    cap.release()
    cv2.destroyAllWindows()

if __name__ == '__main__':
    registrar_desde_camara()

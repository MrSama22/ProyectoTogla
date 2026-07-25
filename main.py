import cv2
from pyzbar.pyzbar import decode, ZBarSymbol
import face_recognition
import numpy as np
import time
import threading
from database import init_db, get_student_by_qr, get_all_students

def main():
    # 1. Inicializar la base de datos
    init_db()
    
    # Cargar todos los estudiantes en memoria
    todos_los_estudiantes = get_all_students()
    
    # 2. Configurar la captura de video
    cap = cv2.VideoCapture("http://192.168.1.37:4747/video")
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    
    print("Iniciando Proyecto Antigravity (Modo Rápido)... Presiona 'q' para salir.")
    
    # Variables de estado
    validado_reciente = None
    metodo_validacion = ""
    tiempo_validacion = 0
    TIEMPO_MENSAJE = 3
    
    PREFERIR_QR = True
    
    ultimo_chequeo_rostro = 0
    
    # Diccionario para compartir datos entre el video y el hilo de la IA
    estado_ia = {
        "procesando": False,
        "candidato": None,
        "mensaje": "",
        "color": (255, 255, 0),
        "ubicacion": []
    }
    
    def procesar_rostro_async(rgb_frame, db_estudiantes):
        estado_ia["procesando"] = True
        
        face_locations = []
        frame_rostro = rgb_frame
        orientacion = "Normal"
        
        rotaciones = [
            (None, "Normal"),
            (cv2.ROTATE_90_CLOCKWISE, "Vertical Derecha"),
            (cv2.ROTATE_90_COUNTERCLOCKWISE, "Vertical Izquierda")
        ]
        
        for rotacion, nombre_rot in rotaciones:
            if rotacion is None:
                frame_rostro = rgb_frame
            else:
                frame_rostro = cv2.rotate(rgb_frame, rotacion)
                
            face_locations = face_recognition.face_locations(frame_rostro)
            if face_locations:
                orientacion = nombre_rot
                break
        
        if not face_locations:
            estado_ia["mensaje"] = ""
            estado_ia["ubicacion"] = []
        else:
            top, right, bottom, left = face_locations[0]
            face_width = right - left
            
            min_w = frame_rostro.shape[1] * 0.15
            max_w = frame_rostro.shape[1] * 0.65
            
            if orientacion == "Normal":
                estado_ia["ubicacion"] = face_locations
            else:
                estado_ia["ubicacion"] = []
            
            if face_width < min_w:
                estado_ia["mensaje"] = "⚠️ Acercate un poco mas"
                estado_ia["color"] = (0, 165, 255)
            elif face_width > max_w:
                estado_ia["mensaje"] = "⚠️ Alejate un poco"
                estado_ia["color"] = (0, 165, 255)
            else:
                estado_ia["mensaje"] = "✅ Analizando rostro..."
                estado_ia["color"] = (0, 255, 0)
                
                face_encodings = face_recognition.face_encodings(frame_rostro, face_locations)
                
                for current_encoding in face_encodings:
                    match_encontrado = False
                    for db_qr, db_nombre, db_encoding in db_estudiantes:
                        matches = face_recognition.compare_faces([db_encoding], current_encoding, tolerance=0.6)
                        if matches[0]:
                            estado_ia["candidato"] = db_nombre
                            match_encontrado = True
                            estado_ia["ubicacion"] = []
                            estado_ia["mensaje"] = ""
                            break
                    
                    if not match_encontrado:
                        estado_ia["mensaje"] = "❌ Rostro desconocido"
                        estado_ia["color"] = (0, 0, 255)
                        
        estado_ia["procesando"] = False

    while True:
        ret, frame = cap.read()
        if not ret:
            break
            
        # --- ESTADO: VALIDADO ---
        if validado_reciente and (time.time() - tiempo_validacion < TIEMPO_MENSAJE):
            cv2.rectangle(frame, (0, 0), (frame.shape[1], frame.shape[0]), (0, 255, 0), 10)
            cv2.putText(frame, f"¡VALIDADO: {validado_reciente}!", (30, 50), cv2.FONT_HERSHEY_DUPLEX, 1.0, (0, 255, 0), 2)
            cv2.putText(frame, f"Por: {metodo_validacion}", (30, 90), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
            cv2.imshow('Proyecto Antigravity - Validacion IP', frame)
            if cv2.waitKey(1) & 0xFF == ord('q'):
                break
            continue
        else:
            validado_reciente = None
            
        # --- ESTADO: BUSCANDO ---
        cv2.putText(frame, "Buscando QR o Rostro...", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 0), 2)
        if estado_ia["mensaje"]:
            cv2.putText(frame, estado_ia["mensaje"], (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.7, estado_ia["color"], 2)
        
        candidato_qr = None
        candidato_rostro = None
        
        # MÉTOD0 1: BUSCAR CÓDIGOS QR
        gray_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        
        # BÚSQUEDA MULTI-ORIENTACIÓN PARA QR (Para celulares verticales)
        rotaciones_qr = [None, cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_90_COUNTERCLOCKWISE]
        qrs_detectados = []
        orientacion_qr = None
        
        for rot in rotaciones_qr:
            if rot is None:
                frame_evaluar = gray_frame
            else:
                frame_evaluar = cv2.rotate(gray_frame, rot)
                
            qrs_detectados = decode(frame_evaluar, symbols=[ZBarSymbol.QRCODE])
            if qrs_detectados:
                orientacion_qr = rot
                break # Si encuentra el QR, deja de buscar en otras orientaciones
                
        if qrs_detectados:
            for qr in qrs_detectados:
                qr_data = qr.data.decode('utf-8')
                
                # Dibujamos el polígono solo si la cámara está normal
                if orientacion_qr is None:
                    pts = np.array([qr.polygon], np.int32).reshape((-1, 1, 2))
                    cv2.polylines(frame, [pts], True, (255, 0, 255), 2)
                else:
                    # Mensaje genérico si está rotado
                    cv2.putText(frame, "LEYENDO QR...", (50, 50), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 0, 255), 2)
                
                student = get_student_by_qr(qr_data)
                if student:
                    candidato_qr = student[0]
                else:
                    cv2.putText(frame, "QR No Registrado", (50, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)

        # MÉTOD0 2: BUSCAR ROSTRO (Asíncrono para eliminar lag)
        if todos_los_estudiantes:
            # Si pasaron 1s y el hilo anterior ya terminó, lanzamos uno nuevo
            if not estado_ia["procesando"] and (time.time() - ultimo_chequeo_rostro > 1.0):
                ultimo_chequeo_rostro = time.time()
                rgb_frame_copy = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB).copy()
                
                hilo_ia = threading.Thread(target=procesar_rostro_async, args=(rgb_frame_copy, todos_los_estudiantes))
                hilo_ia.daemon = True
                hilo_ia.start()
            
            # Recuperar resultados del hilo
            candidato_rostro = estado_ia["candidato"]
            
            # Limpiar el candidato para que no vuelva a validar infinitamente
            if candidato_rostro:
                estado_ia["candidato"] = None
                
            # Dibuja el recuadro si existe
            for (top, right, bottom, left) in estado_ia["ubicacion"]:
                cv2.rectangle(frame, (left, top), (right, bottom), (200, 200, 200), 2)

        # ==============================================================
        # SISTEMA DE PRIORIDAD
        # ==============================================================
        if PREFERIR_QR:
            if candidato_qr:
                validado_reciente = candidato_qr
                metodo_validacion = "Carnet QR"
                tiempo_validacion = time.time()
            elif candidato_rostro:
                validado_reciente = candidato_rostro
                metodo_validacion = "Reconocimiento Facial"
                tiempo_validacion = time.time()
        else: # Preferir Rostro
            if candidato_rostro:
                validado_reciente = candidato_rostro
                metodo_validacion = "Reconocimiento Facial"
                tiempo_validacion = time.time()
            elif candidato_qr:
                validado_reciente = candidato_qr
                metodo_validacion = "Carnet QR"
                tiempo_validacion = time.time()

        cv2.imshow('Proyecto Antigravity - Validacion IP', frame)
        
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break
            
    cap.release()
    cv2.destroyAllWindows()

if __name__ == '__main__':
    main()

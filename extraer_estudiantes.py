import json
import os

def extraer_estudiantes():
    origen = os.path.join(os.path.dirname(__file__), "estudiantes_completos.json")
    destino_raiz = os.path.join(os.path.dirname(__file__), "estudiantes.json")
    destino_webapp = os.path.join(os.path.dirname(__file__), "webapp", "estudiantes.json")
    
    if not os.path.exists(origen):
        print(f"Error: No se encontro el archivo {origen}")
        return
        
    print(f"Leyendo {origen}...")
    with open(origen, "r", encoding="utf-8") as f:
        datos_completos = json.load(f)
        
    print(f"Total de registros encontrados: {len(datos_completos)}")
    
    estudiantes_extraidos = []
    
    for item in datos_completos:
        doc = str(item.get("documento", "")).strip()
        nombre = str(item.get("nombre", "")).strip()
        grado = item.get("grado")
        grupo = str(item.get("grupo", "")).strip()
        
        estudiante_limpio = {
            "documento": doc,
            "nombre": nombre,
            "grado": grado,
            "grupo": grupo
        }
        estudiantes_extraidos.append(estudiante_limpio)
        
    # Guardar en raiz
    with open(destino_raiz, "w", encoding="utf-8") as f:
        json.dump(estudiantes_extraidos, f, ensure_ascii=False, indent=2)
    print(f"Guardado con exito en: {destino_raiz} ({len(estudiantes_extraidos)} estudiantes)")
    
    # Guardar en webapp
    os.makedirs(os.path.dirname(destino_webapp), exist_ok=True)
    with open(destino_webapp, "w", encoding="utf-8") as f:
        json.dump(estudiantes_extraidos, f, ensure_ascii=False, indent=2)
    print(f"Guardado con exito en: {destino_webapp} ({len(estudiantes_extraidos)} estudiantes)")

if __name__ == "__main__":
    extraer_estudiantes()

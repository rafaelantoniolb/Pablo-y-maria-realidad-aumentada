# 🍽️ Pablo y María — Realidad Aumentada (Mesa Interactiva 6DoF)

Aplicación **WebAR de Realidad Aumentada en 6 Grados de Libertad (6DoF)** para las mesas del restaurante **Pablo y María**, desarrollada con **Three.js**, **MindAR (Visión Artificial)** y **WebXR**.

Permite a los comensales escanear un código QR en su mesa y controlar con **mandos de flechitas (`D-Pad`)** una figura 3D animada directamente sobre la superficie real de la mesa (o sobre el individual/posavasos del restaurante), con animaciones interactivas y mini-juego de espera.

---

## 🚀 Opción A: Despliegue en CloudPanel como Sitio HTML Estático (Más Rápido y 0 RAM)

Al ser una aplicación 100% WebGL / WebAR ejecutada en el navegador del cliente, puedes crearla como sitio estático sin necesidad de contenedores adicionales:

### 1. Crear el Sitio en CloudPanel
1. Entra a **CloudPanel** ➔ **Sites** ➔ **+ Add Site**.
2. Selecciona **Create a Static HTML Site**.
3. Ingresa tu subdominio y anota el **Site User**.
4. Ve a la pestaña **SSL/TLS** ➔ **Actions** ➔ **New Let's Encrypt Certificate** ➔ **Create and Install** *(Obligatorio para que los navegadores móviles habiliten la cámara por HTTPS)*.

### 2. Clonar el Repositorio en el Servidor (SSH)
Conéctate por SSH a tu VPS y clona el proyecto en la carpeta `htdocs` del subdominio:

```bash
# Reemplaza <usuario-sitio> y <subdominio> por los datos creados en CloudPanel
cd /home/<usuario-sitio>/htdocs/<subdominio>
rm -rf *
git clone https://github.com/rafaelantoniolb/Pablo-y-maria-realidad-aumentada.git .
chown -R <usuario-sitio>:<usuario-sitio> /home/<usuario-sitio>/htdocs/<subdominio>
```

### 3. Actualizar cuando subas cambios a GitHub
```bash
cd /home/<usuario-sitio>/htdocs/<subdominio>
git pull origin main
```

---

## 🐳 Opción B: Despliegue con Docker + Reverse Proxy en CloudPanel (Puerto `8976`)

Si prefieres usar **Reverse Proxy en CloudPanel** (usando el puerto **`127.0.0.1:8976`**, consecutivo al `8975` del proyecto Bingo):

```bash
git clone https://github.com/rafaelantoniolb/Pablo-y-maria-realidad-aumentada.git /opt/pabloymariaAR
cd /opt/pabloymariaAR
docker compose up -d
```
En CloudPanel:
* **Create a Reverse Proxy**
* **Reverse Proxy Url**: `http://127.0.0.1:8976`
* Activar **Let's Encrypt Certificate** en la pestaña **SSL/TLS**.

---

## 🎮 Funcionalidades del MVP

* **Rastreo Espacial 6DoF (MindAR + Three.js)**: Calcula posición e inclinación real sobre el marcador de la mesa.
* **Modo Mesa 3D 6DoF sin cámara/marcador**: Permite girar e inclinar la mesa en 360° si se accede desde una PC sin webcam.
* **Mandos de Flechitas (`D-Pad` táctil y teclado `WASD`/Flechas)**: Desplazamiento suave con rotación automática e interpolación de animaciones esqueléticas (`Idle`, `Walking`, `Running`, `Dance`, `Wave`, `Jump`, `ThumbsUp`).
* **Mini-Juego de Espera**: Recolección de cristales sobre la mesa mientras el cliente espera su pedido.

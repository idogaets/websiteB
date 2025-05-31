class RCCarController {
  constructor() {
    this.device = null
    this.server = null
    this.service = null
    this.characteristic = null
    this.isConnected = false
    this.isConnecting = false
    this.lastCommand = "None"
    this.pressedKeys = new Set()
    this.connectionType = null // 'bluetooth' or 'wifi'
    this.wifiEndpoint = null
    this.deviceHistory = []
    this.settings = {
      darkMode: true,
      themeColor: "cyan",
      deviceName: "",
      autoReconnect: true,
      commandDelay: 100,
      vibrationFeedback: true,
      soundEffects: false,
      sensitivity: "medium",
      saveHistory: true,
    }

    this.currentSpeed = 5
    this.maxSpeed = 10
    this.minSpeed = 1
    this.distanceValue = null
    this.proximityBeepInterval = null
    this.audioContext = null
    this.isReceivingData = false
    this.dataCharacteristic = null

    // Drive mode functionality
    this.driveMode = "hold" // 'hold' or 'toggle'
    this.toggledDirections = new Set() // Track which directions are toggled on

    // Motor status
    this.motorStatus = {
      motor1: 0,
      motor2: 0,
      motor3: 0,
      motor4: 0,
    }

    // Common BLE UART service UUIDs
    this.serviceUUIDs = [
      "0000ffe0-0000-1000-8000-00805f9b34fb", // HC-05/HC-06/DX-BT24
      "6e400001-b5a3-f393-e0a9-e50e24dcca9e", // Nordic UART
      "0000fff0-0000-1000-8000-00805f9b34fb", // Alternative UART service
      "49535343-fe7d-4ae5-8fa9-9fafd205e455", // Microchip RN4870/71
    ]

    // Extended BLE UART characteristic UUIDs
    this.characteristicUUIDs = [
      "0000ffe1-0000-1000-8000-00805f9b34fb", // HC-05/HC-06/DX-BT24 TX
      "6e400002-b5a3-f393-e0a9-e50e24dcca9e", // Nordic UART TX
      "6e400003-b5a3-f393-e0a9-e50e24dcca9e", // Nordic UART RX
      "0000fff1-0000-1000-8000-00805f9b34fb", // Alternative TX
      "0000fff2-0000-1000-8000-00805f9b34fb", // Alternative RX
      "49535343-1e4d-4bd9-ba61-23c647249616", // Microchip TX
      "49535343-8841-43f4-a8d4-ecbe34729bb3", // Microchip RX
    ]

    this.init()
  }

  init() {
    this.loadSettings()
    this.loadDeviceHistory()
    this.checkBluetoothSupport()
    this.setupEventListeners()
    this.setupNavigation()
    this.setupFileImport()
    this.updateUI()
    this.applyTheme()
    this.updateDriveModeUI()
    this.updateSpeedDisplay()
    this.startConnectionMonitoring()

    // Show iOS guidance if it's an iOS device and first visit
    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)

    if (isIOS && !localStorage.getItem("iosGuidanceShown")) {
      setTimeout(() => {
        this.showIOSGuidance()
        localStorage.setItem("iosGuidanceShown", "true")
      }, 3000)
    }

    // Add page visibility change handler
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        // Page is hidden, reduce activity
        this.stopDataReception()
      } else if (this.isConnected) {
        // Page is visible again, resume activity
        this.setupDataReception()
      }
    })

    // Add beforeunload handler
    window.addEventListener("beforeunload", () => {
      this.cleanup()
    })
  }

  loadSettings() {
    const saved = localStorage.getItem("rcCarSettings")
    if (saved) {
      this.settings = { ...this.settings, ...JSON.parse(saved) }
    }
  }

  saveSettings() {
    localStorage.setItem("rcCarSettings", JSON.stringify(this.settings))
  }

  loadDeviceHistory() {
    const saved = localStorage.getItem("rcCarDeviceHistory")
    if (saved && this.settings.saveHistory) {
      this.deviceHistory = JSON.parse(saved)
    }
  }

  saveDeviceHistory() {
    if (this.settings.saveHistory) {
      localStorage.setItem("rcCarDeviceHistory", JSON.stringify(this.deviceHistory))
    }
  }

  addToDeviceHistory(device) {
    if (!this.settings.saveHistory) return

    const existingIndex = this.deviceHistory.findIndex((d) => d.id === device.id)
    if (existingIndex >= 0) {
      this.deviceHistory[existingIndex].lastConnected = new Date().toISOString()
    } else {
      this.deviceHistory.unshift({
        id: device.id,
        name: device.name,
        lastConnected: new Date().toISOString(),
      })
    }

    // Keep only last 5 devices
    this.deviceHistory = this.deviceHistory.slice(0, 5)
    this.saveDeviceHistory()
    this.updateDeviceHistoryUI()
  }

  updateDeviceHistoryUI() {
    const container = document.getElementById("deviceHistory")
    const previousDevicesSection = document.getElementById("previousDevices")

    if (this.deviceHistory.length === 0) {
      previousDevicesSection.style.display = "none"
      return
    }

    previousDevicesSection.style.display = "block"
    container.innerHTML = ""

    this.deviceHistory.forEach((device) => {
      const deviceItem = document.createElement("div")
      deviceItem.className = "device-history-item"
      deviceItem.innerHTML = `
        <div class="device-info">
          <strong>${device.name}</strong>
          <small>Last connected: ${new Date(device.lastConnected).toLocaleDateString()}</small>
        </div>
        <button class="btn btn-secondary" onclick="controller.reconnectToDevice('${device.id}')">
          <svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6.5 6.5h11"/>
            <path d="M6.5 17.5h11"/>
            <path d="M6.5 12h11"/>
          </svg>
          Reconnect
        </button>
      `
      container.appendChild(deviceItem)
    })
  }

  async reconnectToDevice(deviceId) {
    const device = this.deviceHistory.find((d) => d.id === deviceId)
    if (!device) return

    try {
      this.updateConnectionStatus("Reconnecting...", "connecting")
      await this.connect()
    } catch (error) {
      console.error("Reconnection failed:", error)
      this.updateConnectionStatus("Reconnection failed", "disconnected")
    }
  }

  checkBluetoothSupport() {
    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)

    if (isIOS) {
      // Show iOS-specific alert
      document.getElementById("iosAlert").style.display = "block"
      document.getElementById("connectBtn").disabled = true

      // Update connect button text for iOS
      const connectBtn = document.getElementById("connectBtn")
      connectBtn.innerHTML = `
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 6L6 18"/>
          <path d="M6 6l12 12"/>
        </svg>
        Not Available on iOS
      `
      connectBtn.className = "btn btn-secondary"

      // Update compatibility message
      document.getElementById("compatibilityMessage").textContent =
        "iOS devices detected. Web Bluetooth is not supported by Apple."
      document.getElementById("compatibilityAlert").style.display = "block"

      // Add iOS app link functionality
      document.getElementById("iosAppLink").addEventListener("click", (e) => {
        e.preventDefault()
        this.showNotification("Consider using WiFi connection or check App Store for dedicated RC car apps", "info")
      })

      // Show notification about WiFi alternative
      setTimeout(() => {
        this.showNotification("💡 Tip: Use WiFi connection instead for iOS devices", "info")
      }, 2000)
    } else if (!navigator.bluetooth) {
      document.getElementById("compatibilityAlert").style.display = "block"
      document.getElementById("connectBtn").disabled = true
    }
  }

  setupNavigation() {
    const navButtons = document.querySelectorAll(".nav-btn")
    const pages = document.querySelectorAll(".page")

    navButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const targetPage = btn.dataset.page

        // Update active nav button
        navButtons.forEach((b) => b.classList.remove("active"))
        btn.classList.add("active")

        // Show target page
        pages.forEach((page) => page.classList.remove("active"))
        document.getElementById(`${targetPage}-page`).classList.add("active")
      })
    })
  }

  setupEventListeners() {
    // Bluetooth connect button
    document.getElementById("connectBtn").addEventListener("click", () => {
      if (this.isConnected && this.connectionType === "bluetooth") {
        this.disconnect()
      } else {
        this.connect()
      }
    })

    // WiFi connect button
    document.getElementById("wifiConnectBtn").addEventListener("click", () => {
      if (this.isConnected && this.connectionType === "wifi") {
        this.disconnectWifi()
      } else {
        this.connectWifiWebSocket()
      }
    })

    // D-pad buttons
    document.querySelectorAll(".dpad-btn").forEach((btn) => {
      const command = btn.dataset.command
      const joystick = btn.dataset.joystick

      // Mouse events
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault()
        this.handleButtonPress(command, btn, joystick)
      })

      btn.addEventListener("mouseup", (e) => {
        e.preventDefault()
        this.handleButtonRelease(command, btn, joystick)
      })

      btn.addEventListener("mouseleave", (e) => {
        e.preventDefault()
        this.handleButtonRelease(command, btn, joystick)
      })

      // Touch events
      btn.addEventListener("touchstart", (e) => {
        e.preventDefault()
        this.handleButtonPress(command, btn, joystick)
      })

      btn.addEventListener("touchend", (e) => {
        e.preventDefault()
        this.handleButtonRelease(command, btn, joystick)
      })
    })

    // Command buttons
    document.querySelectorAll(".command-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const command = btn.dataset.command
        this.sendCommand(command, "func")
        this.flashButton(btn)
      })
    })

    // Mode toggle button
    document.getElementById("modeToggle").addEventListener("click", () => {
      this.toggleDriveMode()
    })

    // Keyboard events
    document.addEventListener("keydown", (e) => this.handleKeyDown(e))
    document.addEventListener("keyup", (e) => this.handleKeyUp(e))

    // Settings event listeners
    this.setupSettingsListeners()

    // Prevent context menu on buttons
    document.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("contextmenu", (e) => e.preventDefault())
    })

    // Speed control buttons
    document.getElementById("speedUp").addEventListener("click", () => {
      this.updateSpeed(1)
    })

    document.getElementById("speedDown").addEventListener("click", () => {
      this.updateSpeed(-1)
    })

    // Keyboard shortcuts for speed
    document.addEventListener("keydown", (e) => {
      if (!this.isConnected) return

      if (e.key === "+" || e.key === "=") {
        e.preventDefault()
        this.updateSpeed(1)
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault()
        this.updateSpeed(-1)
      }
    })
  }

  setupSettingsListeners() {
    // Dark mode toggle
    document.getElementById("darkModeToggle").addEventListener("change", (e) => {
      this.settings.darkMode = e.target.checked
      this.saveSettings()
      this.applyTheme()
    })

    // Theme color
    document.getElementById("themeColor").addEventListener("change", (e) => {
      this.settings.themeColor = e.target.value
      this.saveSettings()
      this.applyTheme()
    })

    // Device name
    document.getElementById("deviceName").addEventListener("input", (e) => {
      this.settings.deviceName = e.target.value
      this.saveSettings()
    })

    // Auto reconnect
    document.getElementById("autoReconnect").addEventListener("change", (e) => {
      this.settings.autoReconnect = e.target.checked
      this.saveSettings()
    })

    // Command delay
    const delaySlider = document.getElementById("commandDelay")
    const delayValue = document.getElementById("delayValue")
    delaySlider.addEventListener("input", (e) => {
      this.settings.commandDelay = Number.parseInt(e.target.value)
      delayValue.textContent = `${this.settings.commandDelay}ms`
      this.saveSettings()
    })

    // Other settings
    document.getElementById("vibrationFeedback").addEventListener("change", (e) => {
      this.settings.vibrationFeedback = e.target.checked
      this.saveSettings()
    })

    document.getElementById("soundEffects").addEventListener("change", (e) => {
      this.settings.soundEffects = e.target.checked
      this.saveSettings()
    })

    document.getElementById("sensitivity").addEventListener("change", (e) => {
      this.settings.sensitivity = e.target.value
      this.saveSettings()
    })

    document.getElementById("saveHistory").addEventListener("change", (e) => {
      this.settings.saveHistory = e.target.checked
      this.saveSettings()
      if (!e.target.checked) {
        this.clearDeviceHistory()
      }
    })

    // Action buttons
    document.getElementById("clearHistory").addEventListener("click", () => {
      this.clearDeviceHistory()
    })

    document.getElementById("exportSettings").addEventListener("click", () => {
      this.exportSettings()
    })
  }

  applyTheme() {
    const body = document.body

    // Apply dark/light mode
    if (this.settings.darkMode) {
      body.removeAttribute("data-theme")
    } else {
      body.setAttribute("data-theme", "light")
    }

    // Apply accent color
    body.setAttribute("data-accent", this.settings.themeColor)

    // Update settings UI
    document.getElementById("darkModeToggle").checked = this.settings.darkMode
    document.getElementById("themeColor").value = this.settings.themeColor
    document.getElementById("deviceName").value = this.settings.deviceName
    document.getElementById("autoReconnect").checked = this.settings.autoReconnect
    document.getElementById("commandDelay").value = this.settings.commandDelay
    document.getElementById("delayValue").textContent = `${this.settings.commandDelay}ms`
    document.getElementById("vibrationFeedback").checked = this.settings.vibrationFeedback
    document.getElementById("soundEffects").checked = this.settings.soundEffects
    document.getElementById("sensitivity").value = this.settings.sensitivity
    document.getElementById("saveHistory").checked = this.settings.saveHistory
  }

  clearDeviceHistory() {
    this.deviceHistory = []
    localStorage.removeItem("rcCarDeviceHistory")
    this.updateDeviceHistoryUI()
  }

  exportSettings() {
    const data = {
      settings: this.settings,
      deviceHistory: this.deviceHistory,
      exportDate: new Date().toISOString(),
    }

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "rc-car-controller-settings.json"
    a.click()
    URL.revokeObjectURL(url)
  }

  // Add method to handle structured data parsing
  parseStructuredMessage(message) {
    try {
      // Handle both {key:value} and JSON formats
      if (message.startsWith("{") && message.endsWith("}")) {
        if (message.includes(":") && !message.includes('"')) {
          // Simple {key:value} format
          const content = message.slice(1, -1)
          const [key, value] = content.split(":")
          return { [key.trim()]: value.trim() }
        } else {
          // JSON format
          return JSON.parse(message)
        }
      }
      return null
    } catch (error) {
      console.error("Error parsing structured message:", error)
      return null
    }
  }

  // Enhanced data handling for multiple sensor types
  handleStructuredData(key, value) {
    switch (key) {
      case "distance":
        const distance = Number.parseInt(value)
        if (!isNaN(distance) && distance >= 0) {
          this.updateDistanceDisplay(distance)
        }
        break

      case "motor1":
      case "motor2":
      case "motor3":
      case "motor4":
        const motorValue = Number.parseInt(value)
        if (!isNaN(motorValue) && motorValue >= 0 && motorValue <= 100) {
          const motorData = { [key]: motorValue }
          this.updateMotorStatus(motorData)
        }
        break

      case "battery":
        const batteryLevel = Number.parseInt(value)
        if (!isNaN(batteryLevel) && batteryLevel >= 0 && batteryLevel <= 100) {
          this.updateBatteryStatus(batteryLevel)
        }
        break

      case "temperature":
        const temp = Number.parseFloat(value)
        if (!isNaN(temp)) {
          this.updateTemperature(temp)
        }
        break

      case "status":
        this.updateDeviceStatus(value)
        break

      default:
        console.log(`Unknown data key: ${key}`)
    }
  }

  // Battery status update method
  updateBatteryStatus(level) {
    const batteryElement = document.getElementById("batteryLevel")
    const batteryFill = document.getElementById("batteryFill")

    if (batteryElement) {
      batteryElement.textContent = `${level}%`
    }

    if (batteryFill) {
      batteryFill.style.width = `${level}%`

      // Color coding for battery level
      if (level > 60) {
        batteryFill.className = "battery-fill high"
      } else if (level > 30) {
        batteryFill.className = "battery-fill medium"
      } else {
        batteryFill.className = "battery-fill low"
      }
    }
  }

  // Temperature update method
  updateTemperature(temp) {
    const tempElement = document.getElementById("temperature")
    if (tempElement) {
      tempElement.textContent = `${temp.toFixed(1)}°C`
    }
  }

  // Device status update method
  updateDeviceStatus(status) {
    const statusElement = document.getElementById("deviceStatusText")
    if (statusElement) {
      statusElement.textContent = status
    }
  }

  // Enhanced error handling
  handleConnectionError(error) {
    console.error("Connection error:", error)

    let errorMessage = "Connection failed"

    if (error.name === "NotFoundError") {
      errorMessage = "No compatible device found"
    } else if (error.name === "SecurityError") {
      errorMessage = "Connection blocked by security policy"
    } else if (error.name === "NetworkError") {
      errorMessage = "Network connection failed"
    } else if (error.name === "InvalidStateError") {
      errorMessage = "Device is not in a valid state"
    } else if (error.message) {
      errorMessage = error.message
    }

    this.updateConnectionStatus(`Error: ${errorMessage}`, "disconnected")

    // Show user-friendly error notification
    this.showNotification(errorMessage, "error")
  }

  // Notification system
  showNotification(message, type = "info") {
    const notification = document.createElement("div")
    notification.className = `notification notification-${type}`
    notification.innerHTML = `
      <div class="notification-content">
        <span>${message}</span>
        <button class="notification-close" onclick="this.parentElement.parentElement.remove()">
          <svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    `

    document.body.appendChild(notification)

    // Auto-remove after 5 seconds
    setTimeout(() => {
      if (notification.parentElement) {
        notification.remove()
      }
    }, 5000)
  }

  // Enhanced WiFi connection with WebSocket support
  async connectWifiWebSocket() {
    const ip = document.getElementById("wifiIP").value
    const port = document.getElementById("wifiPort").value

    if (!ip) {
      this.showNotification("Please enter a valid IP address", "error")
      return
    }

    try {
      this.updateWifiStatus("Connecting...", "connecting")

      // Try WebSocket connection first
      const wsUrl = `ws://${ip}:${port}/ws`
      this.wifiSocket = new WebSocket(wsUrl)

      this.wifiSocket.onopen = () => {
        this.isConnected = true
        this.connectionType = "wifi"
        this.wifiEndpoint = `${ip}:${port}`
        this.updateWifiStatus("Connected via WebSocket", "connected")
        this.updateUI()
        this.showNotification("WiFi WebSocket connected successfully", "success")
      }

      this.wifiSocket.onmessage = (event) => {
        this.handleIncomingData(new TextEncoder().encode(event.data))
      }

      this.wifiSocket.onclose = () => {
        this.handleDisconnection()
        this.showNotification("WiFi connection lost", "warning")
      }

      this.wifiSocket.onerror = (error) => {
        console.error("WebSocket error:", error)
        this.updateWifiStatus("WebSocket failed, trying HTTP...", "connecting")
        // Fallback to HTTP
        this.connectWifi()
      }
    } catch (error) {
      console.error("WiFi WebSocket connection failed:", error)
      this.updateWifiStatus(`Error: ${error.message}`, "disconnected")
      this.wifiEndpoint = null
      this.handleConnectionError(error)
    }
  }

  // Enhanced WiFi command sending
  async sendWifiCommand(command) {
    if (this.wifiSocket && this.wifiSocket.readyState === WebSocket.OPEN) {
      // Send via WebSocket
      this.wifiSocket.send(command)
    } else if (this.wifiEndpoint) {
      // Send via HTTP
      const response = await fetch(`http://${this.wifiEndpoint}/command`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ command }),
        timeout: 5000,
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
    } else {
      throw new Error("No WiFi connection available")
    }
  }

  // Auto-reconnection functionality
  async attemptAutoReconnect() {
    if (!this.settings.autoReconnect || this.isConnecting) {
      return
    }

    const lastDevice = this.deviceHistory[0]
    if (!lastDevice) {
      return
    }

    console.log("Attempting auto-reconnect...")
    this.showNotification("Attempting to reconnect...", "info")

    try {
      await this.connect()
    } catch (error) {
      console.log("Auto-reconnect failed:", error.message)
    }
  }

  // Connection health monitoring
  startConnectionMonitoring() {
    if (this.connectionMonitorInterval) {
      clearInterval(this.connectionMonitorInterval)
    }

    this.connectionMonitorInterval = setInterval(() => {
      if (this.isConnected) {
        this.sendHeartbeat()
      }
    }, 10000) // Check every 10 seconds
  }

  stopConnectionMonitoring() {
    if (this.connectionMonitorInterval) {
      clearInterval(this.connectionMonitorInterval)
      this.connectionMonitorInterval = null
    }
  }

  async sendHeartbeat() {
    try {
      await this.sendStructuredCommand("ping", Date.now().toString())
    } catch (error) {
      console.log("Heartbeat failed:", error.message)
      // Connection might be lost
      if (this.isConnected) {
        this.handleDisconnection()
      }
    }
  }

  // Enhanced cleanup method
  cleanup() {
    this.stopDataReception()
    this.stopConnectionMonitoring()
    this.stopProximityBeeping()

    if (this.wifiSocket) {
      this.wifiSocket.close()
      this.wifiSocket = null
    }

    this.device = null
    this.server = null
    this.service = null
    this.characteristic = null
    this.dataCharacteristic = null
    this.isConnected = false
    this.isConnecting = false
    this.connectionType = null
    this.wifiEndpoint = null
    this.pressedKeys.clear()
    this.toggledDirections.clear()
  }

  // Import settings from file
  async importSettings(file) {
    try {
      const text = await file.text()
      const data = JSON.parse(text)

      if (data.settings) {
        this.settings = { ...this.settings, ...data.settings }
        this.saveSettings()
        this.applyTheme()
      }

      if (data.deviceHistory && this.settings.saveHistory) {
        this.deviceHistory = data.deviceHistory
        this.saveDeviceHistory()
        this.updateDeviceHistoryUI()
      }

      this.showNotification("Settings imported successfully", "success")
    } catch (error) {
      console.error("Failed to import settings:", error)
      this.showNotification("Failed to import settings", "error")
    }
  }

  // Add file input handler for settings import
  setupFileImport() {
    const fileInput = document.createElement("input")
    fileInput.type = "file"
    fileInput.accept = ".json"
    fileInput.style.display = "none"

    fileInput.addEventListener("change", (e) => {
      const file = e.target.files[0]
      if (file) {
        this.importSettings(file)
      }
    })

    document.body.appendChild(fileInput)

    // Add import button to settings
    const importBtn = document.createElement("button")
    importBtn.className = "btn btn-secondary"
    importBtn.innerHTML = `
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="17,8 12,3 7,8"/>
        <line x1="12" x2="12" y1="3" y2="15"/>
      </svg>
      Import Settings
    `

    importBtn.addEventListener("click", () => {
      fileInput.click()
    })

    const exportBtn = document.getElementById("exportSettings")
    if (exportBtn && exportBtn.parentElement) {
      exportBtn.parentElement.insertBefore(importBtn, exportBtn)
    }
  }

  // Drive Mode Functions
  toggleDriveMode() {
    this.driveMode = this.driveMode === "hold" ? "toggle" : "hold"
    this.updateDriveModeUI()

    // Clear any toggled directions when switching to hold mode
    if (this.driveMode === "hold") {
      this.toggledDirections.clear()
      this.sendCommand("S", "cmd") // Stop all movement
    }

    // Send mode change to Arduino
    this.sendStructuredCommand("mode", this.driveMode)
  }

  updateDriveModeUI() {
    const modeTitle = document.getElementById("currentModeTitle")
    const modeDesc = document.getElementById("currentModeDesc")
    const modeText = document.getElementById("modeText")
    const modeStatus = document.getElementById("modeStatus")
    const toggleIcon = document.getElementById("toggleIcon")

    if (this.driveMode === "hold") {
      if (modeTitle) modeTitle.textContent = "Hold-to-Move Mode"
      if (modeDesc) modeDesc.textContent = "Vehicle stops when button is released"
      if (modeText) modeText.textContent = "Hold Mode"
      if (modeStatus) modeStatus.className = "mode-status hold-mode"
      if (toggleIcon) {
        toggleIcon.innerHTML = `
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <path d="M9 9h6v6H9z"/>
          </svg>
        `
      }
    } else {
      if (modeTitle) modeTitle.textContent = "Toggle-to-Move Mode"
      if (modeDesc) modeDesc.textContent = "Vehicle continues until stopped or toggled"
      if (modeText) modeText.textContent = "Toggle Mode"
      if (modeStatus) modeStatus.className = "mode-status toggle-mode"
      if (toggleIcon) {
        toggleIcon.innerHTML = `
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 12l2 2 4-4"/>
            <circle cx="12" cy="12" r="10"/>
          </svg>
        `
      }
    }
  }

  handleButtonPress(command, button, joystick) {
    if (!this.isConnected) return

    // Add press animation
    button.classList.add("btn-pressed")
    setTimeout(() => button.classList.remove("btn-pressed"), 150)

    if (joystick === "wasd") {
      this.handleMovementCommand(command)
    } else if (joystick === "arrows") {
      this.sendCommand(command, "srv")
    }

    // Haptic feedback
    if (this.settings.vibrationFeedback && navigator.vibrate) {
      navigator.vibrate(50)
    }
  }

  handleButtonRelease(command, button, joystick) {
    if (!this.isConnected) return

    button.classList.remove("btn-active", "btn-pressed")

    // Only send stop on release in hold mode for movement commands
    if (this.driveMode === "hold" && joystick === "wasd" && !["S"].includes(command)) {
      this.sendCommand("S", "cmd")
    }
    // Servo commands always stop on release regardless of mode
    else if (joystick === "arrows" && !["CENTER"].includes(command)) {
      this.sendCommand("CENTER", "srv")
    }
  }

  handleMovementCommand(command) {
    if (this.driveMode === "hold") {
      // Standard hold mode - send command directly
      this.sendCommand(command, "cmd")
    } else {
      // Toggle mode logic
      if (command === "S") {
        // Stop command always stops and clears toggles
        this.toggledDirections.clear()
        this.sendCommand("S", "cmd")
      } else {
        // Check if this direction is already toggled
        if (this.toggledDirections.has(command)) {
          // Turn off this direction
          this.toggledDirections.delete(command)
          this.sendCommand("S", "cmd")
        } else {
          // Turn on this direction (and turn off others)
          this.toggledDirections.clear()
          this.toggledDirections.add(command)
          this.sendCommand(command, "cmd")
        }
      }
    }
  }

  handleKeyDown(e) {
    if (!this.isConnected) return

    const key = e.key.toLowerCase()

    // Prevent default for space to avoid page scroll
    if (key === " ") {
      e.preventDefault()
    }

    // Avoid repeated keydown events
    if (this.pressedKeys.has(key)) return
    this.pressedKeys.add(key)

    // Handle mode toggle
    if (key === "m") {
      this.toggleDriveMode()
      return
    }

    const keyMap = {
      // WASD controls
      w: { command: "F", type: "cmd", joystick: "wasd" },
      a: { command: "L", type: "cmd", joystick: "wasd" },
      s: { command: "B", type: "cmd", joystick: "wasd" },
      d: { command: "R", type: "cmd", joystick: "wasd" },
      // Arrow controls (servo)
      arrowup: { command: "UP", type: "srv", joystick: "arrows" },
      arrowleft: { command: "LEFT", type: "srv", joystick: "arrows" },
      arrowdown: { command: "DOWN", type: "srv", joystick: "arrows" },
      arrowright: { command: "RIGHT", type: "srv", joystick: "arrows" },
      // Special commands
      " ": { command: "CENTER", type: "srv", joystick: "arrows" },
      h: { command: "HORN", type: "func", joystick: "special" },
      l: { command: "LIGHTS", type: "func", joystick: "special" },
      o: { command: "SERVO", type: "func", joystick: "special" },
      z: { command: "S", type: "cmd", joystick: "wasd" }, // Emergency stop
    }

    // Handle Ctrl+A for auto mode
    if (key === "a" && e.ctrlKey) {
      e.preventDefault()
      this.sendCommand("AUTO", "func")
      return
    }

    if (keyMap[key]) {
      const { command, type, joystick } = keyMap[key]

      if (joystick === "wasd") {
        this.handleMovementCommand(command)
      } else {
        this.sendCommand(command, type)
      }

      this.highlightKeyboardButton(key)
    }
  }

  handleKeyUp(e) {
    const key = e.key.toLowerCase()
    this.pressedKeys.delete(key)
    this.removeKeyboardHighlight(key)

    // Simulate button release for WASD keys in hold mode
    if (this.driveMode === "hold") {
      const movementKeys = ["w", "a", "s", "d"]
      if (movementKeys.includes(key)) {
        this.sendCommand("S", "cmd")
      }
    }

    // Simulate button release for arrow keys
    const arrowKeys = ["arrowup", "arrowleft", "arrowdown", "arrowright"]
    if (arrowKeys.includes(key)) {
      this.sendCommand("CENTER", "srv")
    }
  }

  highlightKeyboardButton(key) {
    const buttonMap = {
      w: '[data-joystick="wasd"][data-command="F"]',
      a: '[data-joystick="wasd"][data-command="L"]',
      s: '[data-joystick="wasd"][data-command="B"]',
      d: '[data-joystick="wasd"][data-command="R"]',
      arrowup: '[data-joystick="arrows"][data-command="UP"]',
      arrowleft: '[data-joystick="arrows"][data-command="LEFT"]',
      arrowdown: '[data-joystick="arrows"][data-command="DOWN"]',
      arrowright: '[data-joystick="arrows"][data-command="RIGHT"]',
      " ": '[data-joystick="arrows"][data-command="CENTER"]',
    }

    if (buttonMap[key]) {
      const button = document.querySelector(buttonMap[key])
      if (button) button.classList.add("btn-active")
    }
  }

  removeKeyboardHighlight(key) {
    const buttonMap = {
      w: '[data-joystick="wasd"][data-command="F"]',
      a: '[data-joystick="wasd"][data-command="L"]',
      s: '[data-joystick="wasd"][data-command="B"]',
      d: '[data-joystick="wasd"][data-command="R"]',
      arrowup: '[data-joystick="arrows"][data-command="UP"]',
      arrowleft: '[data-joystick="arrows"][data-command="LEFT"]',
      arrowdown: '[data-joystick="arrows"][data-command="DOWN"]',
      arrowright: '[data-joystick="arrows"][data-command="RIGHT"]',
      " ": '[data-joystick="arrows"][data-command="CENTER"]',
    }

    if (buttonMap[key]) {
      const button = document.querySelector(buttonMap[key])
      if (button) button.classList.remove("btn-active")
    }
  }

  flashButton(button) {
    button.classList.add("btn-active")
    setTimeout(() => {
      button.classList.remove("btn-active")
    }, 200)
  }

  async connect() {
    if (this.isConnecting) return

    try {
      this.isConnecting = true
      this.updateConnectionStatus("Connecting...", "connecting")

      // Extended device filters including DX-BT24
      this.device = await navigator.bluetooth.requestDevice({
        filters: [
          { namePrefix: "HC-05" },
          { namePrefix: "HC-06" },
          { namePrefix: "ESP32" },
          { namePrefix: "ESP" },
          { namePrefix: "DX-BT24" },
          { namePrefix: "DX" },
          { namePrefix: "BT24" },
          { namePrefix: "MLT-BT05" },
        ],
        optionalServices: this.serviceUUIDs,
      })

      this.updateConnectionStatus("Connecting to device...", "connecting")

      // Connect to GATT server
      this.server = await this.device.gatt.connect()

      this.updateConnectionStatus("Discovering services...", "connecting")

      // Try to find a compatible service
      let serviceFound = false
      for (const serviceUUID of this.serviceUUIDs) {
        try {
          this.service = await this.server.getPrimaryService(serviceUUID)
          serviceFound = true
          break
        } catch (e) {
          console.log(`Service ${serviceUUID} not found, trying next...`)
        }
      }

      if (!serviceFound) {
        throw new Error("No compatible UART service found")
      }

      this.updateConnectionStatus("Finding characteristics...", "connecting")

      // Try to find a compatible characteristic
      let characteristicFound = false
      for (const charUUID of this.characteristicUUIDs) {
        try {
          this.characteristic = await this.service.getCharacteristic(charUUID)
          characteristicFound = true
          break
        } catch (e) {
          console.log(`Characteristic ${charUUID} not found, trying next...`)
        }
      }

      if (!characteristicFound) {
        throw new Error("No compatible UART characteristic found")
      }

      // Set up disconnect handler
      this.device.addEventListener("gattserverdisconnected", () => {
        this.handleDisconnection()
      })

      this.isConnected = true
      this.connectionType = "bluetooth"
      this.updateConnectionStatus("Connected", "connected")
      this.addToDeviceHistory(this.device)
      this.updateUI()
      await this.setupDataReception()
    } catch (error) {
      console.error("Connection failed:", error)
      this.updateConnectionStatus(`Error: ${error.message}`, "disconnected")
      this.cleanup()
    } finally {
      this.isConnecting = false
    }
  }

  async connectWifi() {
    const ip = document.getElementById("wifiIP").value
    const port = document.getElementById("wifiPort").value

    if (!ip) {
      alert("Please enter a valid IP address")
      return
    }

    try {
      this.updateWifiStatus("Connecting...", "connecting")
      this.wifiEndpoint = `http://${ip}:${port}`

      // Test connection with a simple request
      const response = await fetch(`${this.wifiEndpoint}/status`, {
        method: "GET",
        timeout: 5000,
      })

      if (response.ok) {
        this.isConnected = true
        this.connectionType = "wifi"
        this.updateWifiStatus("Connected", "connected")
        this.updateUI()
        this.setupDataReception()
      } else {
        throw new Error("Device not responding")
      }
    } catch (error) {
      console.error("WiFi connection failed:", error)
      this.updateWifiStatus(`Error: ${error.message}`, "disconnected")
      this.wifiEndpoint = null
      this.handleConnectionError(error)
    }
  }

  disconnect() {
    if (this.device && this.device.gatt.connected) {
      this.device.gatt.disconnect()
    }
    this.cleanup()
  }

  disconnectWifi() {
    this.wifiEndpoint = null
    this.connectionType = null
    this.isConnected = false
    this.updateWifiStatus("Disconnected", "disconnected")
    this.updateUI()
  }

  handleDisconnection() {
    console.log("Device disconnected")
    this.cleanup()
    this.updateConnectionStatus("Disconnected", "disconnected")
    this.updateUI()
  }

  cleanup() {
    this.stopDataReception()
    this.stopConnectionMonitoring()
    this.stopProximityBeeping()

    if (this.wifiSocket) {
      this.wifiSocket.close()
      this.wifiSocket = null
    }

    this.device = null
    this.server = null
    this.service = null
    this.characteristic = null
    this.dataCharacteristic = null
    this.isConnected = false
    this.isConnecting = false
    this.connectionType = null
    this.wifiEndpoint = null
    this.pressedKeys.clear()
    this.toggledDirections.clear()
  }

  async sendCommand(command, type = "cmd") {
    if (!this.isConnected) {
      console.log("Not connected, cannot send command")
      return
    }

    try {
      await this.sendStructuredCommand(type, command)
      this.lastCommand = command
      this.updateLastCommand()
      console.log(`Sent ${type}:${command}`)

      // Add command delay if configured
      if (this.settings.commandDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.settings.commandDelay))
      }
    } catch (error) {
      console.error("Failed to send command:", error)
      this.updateConnectionStatus("Error sending command", "disconnected")
    }
  }

  async sendStructuredCommand(key, value) {
    const message = `{${key}:${value}}`

    if (this.connectionType === "bluetooth") {
      await this.sendBluetoothCommand(message)
    } else if (this.connectionType === "wifi") {
      await this.sendWifiCommand(message)
    }
  }

  async sendBluetoothCommand(command) {
    if (!this.characteristic) throw new Error("No characteristic available")

    const encoder = new TextEncoder()
    // Add newline character to ensure proper parsing on Arduino side
    const data = encoder.encode(command + "\n")

    if (this.characteristic.properties.writeWithoutResponse) {
      await this.characteristic.writeValueWithoutResponse(data)
    } else if (this.characteristic.properties.write) {
      await this.characteristic.writeValue(data)
    } else {
      throw new Error("Characteristic does not support writing")
    }
  }

  async sendWifiCommand(command) {
    if (this.wifiSocket && this.wifiSocket.readyState === WebSocket.OPEN) {
      // Send via WebSocket
      this.wifiSocket.send(command)
    } else if (this.wifiEndpoint) {
      // Send via HTTP
      const response = await fetch(`http://${this.wifiEndpoint}/command`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ command }),
        timeout: 5000,
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
    } else {
      throw new Error("No WiFi connection available")
    }
  }

  updateConnectionStatus(status, type) {
    const statusElement = document.getElementById("connectionStatus")
    const detailedStatusElement = document.getElementById("detailedStatus")
    const deviceStatusElement = document.getElementById("deviceStatus")

    if (statusElement) statusElement.textContent = status
    if (detailedStatusElement) detailedStatusElement.textContent = status
    if (deviceStatusElement)
      deviceStatusElement.textContent = status

      // Remove all status classes
    ;[statusElement, deviceStatusElement].forEach((el) => {
      if (el) {
        el.classList.remove("status-connected", "status-disconnected", "status-connecting")
        if (type) {
          el.classList.add(`status-${type}`)
        }
      }
    })
  }

  updateWifiStatus(status, type) {
    const wifiStatusElement = document.getElementById("wifiStatus")
    const wifiEndpointElement = document.getElementById("wifiEndpoint")

    if (wifiStatusElement) wifiStatusElement.textContent = status
    if (wifiEndpointElement) {
      wifiEndpointElement.textContent = this.wifiEndpoint || "None"
    }
  }

  updateLastCommand() {
    const lastCommandElements = [document.getElementById("lastCommand"), document.getElementById("lastCommandSent")]

    lastCommandElements.forEach((el) => {
      if (el) el.textContent = `Last: ${this.lastCommand}`
    })
  }

  updateUI() {
    this.updateConnectButtons()
    this.updateDeviceNames()
    this.updateControlButtons()
    this.updateDeviceHistoryUI()
  }

  updateConnectButtons() {
    const connectBtn = document.getElementById("connectBtn")
    const wifiConnectBtn = document.getElementById("wifiConnectBtn")

    // Bluetooth button
    if (this.isConnecting) {
      connectBtn.innerHTML = `
        <svg class="icon loading" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 12a9 9 0 11-6.219-8.56"/>
        </svg>
        Connecting...
      `
      connectBtn.disabled = true
    } else if (this.isConnected && this.connectionType === "bluetooth") {
      connectBtn.innerHTML = `
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 6L6 18"/>
          <path d="M6 6l12 12"/>
        </svg>
        Disconnect
      `
      connectBtn.className = "btn btn-danger"
      connectBtn.disabled = false
    } else {
      connectBtn.innerHTML = `
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M6.5 6.5h11"/>
          <path d="M6.5 17.5h11"/>
          <path d="M6.5 12h11"/>
        </svg>
        Connect to Device
      `
      connectBtn.className = "btn"
      connectBtn.disabled = false
    }

    // WiFi button
    if (this.isConnected && this.connectionType === "wifi") {
      wifiConnectBtn.innerHTML = `
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 6L6 18"/>
          <path d="M6 6l12 12"/>
        </svg>
        Disconnect WiFi
      `
      wifiConnectBtn.className = "btn btn-danger"
    } else {
      wifiConnectBtn.innerHTML = `
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M5 12.55a11 11 0 0 1 14.08 0"/>
          <path d="M1.42 9a16 16 0 0 1 21.16 0"/>
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
          <path d="M12 20h.01"/>
        </svg>
        Connect via WiFi
      `
      wifiConnectBtn.className = "btn"
    }
  }

  updateDeviceNames() {
    const deviceNameElements = [
      document.getElementById("deviceName"),
      document.getElementById("detailedDevice"),
      document.getElementById("connectedDeviceName"),
    ]

    let deviceName = "No device"
    if (this.isConnected) {
      if (this.connectionType === "bluetooth" && this.device) {
        deviceName = this.settings.deviceName || this.device.name
      } else if (this.connectionType === "wifi" && this.wifiEndpoint) {
        deviceName = this.settings.deviceName || `WiFi Device (${this.wifiEndpoint})`
      }
    }

    deviceNameElements.forEach((el) => {
      if (el && el.tagName !== "INPUT") {
        el.textContent = deviceName
      }
    })
  }

  updateControlButtons() {
    const controlButtons = document.querySelectorAll(".dpad-btn, .command-btn, .speed-btn, .mode-toggle-btn")
    controlButtons.forEach((btn) => {
      btn.disabled = !this.isConnected
    })

    this.updateSpeedDisplay()
  }

  updateSpeed(delta) {
    const newSpeed = Math.max(this.minSpeed, Math.min(this.maxSpeed, this.currentSpeed + delta))
    if (newSpeed !== this.currentSpeed) {
      this.currentSpeed = newSpeed
      this.updateSpeedDisplay()
      this.sendStructuredCommand("speed", this.currentSpeed.toString())
    }
  }

  updateSpeedDisplay() {
    const speedElement = document.getElementById("currentSpeed")
    const speedFill = document.getElementById("speedFill")

    if (speedElement) {
      speedElement.textContent = this.currentSpeed
    }

    if (speedFill) {
      const percentage = (this.currentSpeed / this.maxSpeed) * 100
      speedFill.style.width = `${percentage}%`
    }

    // Update speed button states
    const speedUpBtn = document.getElementById("speedUp")
    const speedDownBtn = document.getElementById("speedDown")

    if (speedUpBtn) {
      speedUpBtn.disabled = !this.isConnected || this.currentSpeed >= this.maxSpeed
    }
    if (speedDownBtn) {
      speedDownBtn.disabled = !this.isConnected || this.currentSpeed <= this.minSpeed
    }
  }

  updateDistanceDisplay(distance) {
    this.distanceValue = distance

    const distanceElement = document.getElementById("distanceValue")
    const proximityFill = document.getElementById("proximityFill")
    const proximityStatus = document.getElementById("proximityStatus")
    const proximityText = document.getElementById("proximityText")
    const proximityIcon = document.getElementById("proximityIcon")

    if (distanceElement) {
      distanceElement.textContent = `${distance} cm`
    }

    // Calculate proximity percentage (closer = higher percentage)
    const maxDistance = 100 // cm
    const proximityPercentage = Math.max(0, Math.min(100, ((maxDistance - distance) / maxDistance) * 100))

    if (proximityFill) {
      proximityFill.style.width = `${proximityPercentage}%`
    }

    // Update status based on distance
    let status = "safe"
    let statusText = "Safe"
    let iconPath = "M8 12h8" // neutral line

    if (distance < 20) {
      status = "danger"
      statusText = "DANGER"
      iconPath =
        "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.464 0L4.34 16.5c-.77.833.192 2.5 1.732 2.5z" // warning triangle
      this.startProximityBeeping(200) // Fast beeping
    } else if (distance < 50) {
      status = "warning"
      statusText = "Warning"
      iconPath =
        "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.464 0L4.34 16.5c-.77.833.192 2.5 1.732 2.5z" // warning triangle
      this.startProximityBeeping(800) // Slow beeping
    } else {
      this.stopProximityBeeping()
    }

    if (proximityFill) {
      proximityFill.className = `proximity-fill ${status}`
    }

    if (proximityStatus) {
      proximityStatus.className = `proximity-status ${status}`
    }

    if (proximityText) {
      proximityText.textContent = statusText
    }

    if (proximityIcon) {
      proximityIcon.innerHTML = `<path d="${iconPath}"/>`
    }
  }

  updateMotorStatus(motorData) {
    for (let i = 1; i <= 4; i++) {
      const motorKey = `motor${i}`
      const value = motorData[motorKey] || 0
      const fill = document.getElementById(`${motorKey}Fill`)
      const valueEl = document.getElementById(`${motorKey}Value`)

      if (fill) {
        fill.style.width = `${value}%`
        // Color based on usage
        if (value > 80) {
          fill.className = "motor-fill high"
        } else if (value > 50) {
          fill.className = "motor-fill medium"
        } else {
          fill.className = "motor-fill low"
        }
      }

      if (valueEl) {
        valueEl.textContent = `${value}%`
      }

      // Update internal motor status
      this.motorStatus[motorKey] = value
    }
  }

  initAudioContext() {
    if (!this.audioContext && this.settings.soundEffects) {
      try {
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)()
      } catch (e) {
        console.log("Audio context not supported")
      }
    }
  }

  playBeep(frequency = 800, duration = 100) {
    if (!this.audioContext || !this.settings.soundEffects) return

    const oscillator = this.audioContext.createOscillator()
    const gainNode = this.audioContext.createGain()

    oscillator.connect(gainNode)
    gainNode.connect(this.audioContext.destination)

    oscillator.frequency.setValueAtTime(frequency, this.audioContext.currentTime)
    oscillator.type = "sine"

    gainNode.gain.setValueAtTime(0.1, this.audioContext.currentTime)
    gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + duration / 1000)

    oscillator.start(this.audioContext.currentTime)
    oscillator.stop(this.audioContext.currentTime + duration / 1000)
  }

  startProximityBeeping(interval) {
    this.stopProximityBeeping()
    this.initAudioContext()

    this.proximityBeepInterval = setInterval(() => {
      this.playBeep(1000, 100)
    }, interval)
  }

  stopProximityBeeping() {
    if (this.proximityBeepInterval) {
      clearInterval(this.proximityBeepInterval)
      this.proximityBeepInterval = null
    }
  }

  async setupDataReception() {
    if (this.connectionType === "bluetooth" && this.service) {
      try {
        // Try to find a characteristic for receiving data (usually RX characteristic)
        const rxCharacteristicUUIDs = [
          "6e400003-b5a3-f393-e0a9-e50e24dcca9e", // Nordic UART RX
          "0000ffe1-0000-1000-8000-00805f9b34fb", // HC-05/HC-06 (same as TX, bidirectional)
          "0000fff2-0000-1000-8000-00805f9b34fb", // Alternative RX
          "49535343-8841-43f4-a8d4-ecbe34729bb3", // Microchip RX
        ]

        for (const charUUID of rxCharacteristicUUIDs) {
          try {
            this.dataCharacteristic = await this.service.getCharacteristic(charUUID)
            if (this.dataCharacteristic.properties.notify || this.dataCharacteristic.properties.read) {
              break
            }
          } catch (e) {
            // Try next characteristic
          }
        }

        if (this.dataCharacteristic && this.dataCharacteristic.properties.notify) {
          await this.dataCharacteristic.startNotifications()
          this.dataCharacteristic.addEventListener("characteristicvaluechanged", (event) => {
            this.handleIncomingData(event.target.value)
          })
          console.log("Data reception setup complete")
        } else if (this.dataCharacteristic && this.dataCharacteristic.properties.read) {
          // Start polling for data
          this.startDataPolling()
        }
      } catch (error) {
        console.log("Could not setup data reception:", error.message)
      }
    } else if (this.connectionType === "wifi") {
      // Start polling for WiFi data
      this.startWifiDataPolling()
    }
  }

  handleIncomingData(dataValue) {
    try {
      const decoder = new TextDecoder()
      const data = decoder.decode(dataValue).trim()

      // Parse structured data - expecting format like "{distance:25}" or "{motor1:75}"
      if (data.startsWith("{") && data.endsWith("}")) {
        const content = data.slice(1, -1) // Remove braces
        const [key, value] = content.split(":")

        if (key && value) {
          this.handleStructuredData(key.trim(), value.trim())
        }
      } else {
        // Fallback for legacy format
        const distance = Number.parseInt(data)
        if (!isNaN(distance) && distance >= 0) {
          this.updateDistanceDisplay(distance)
        }
      }

      console.log("Received data:", data)
    } catch (error) {
      console.error("Error parsing incoming data:", error)
    }
  }

  handleStructuredData(key, value) {
    switch (key) {
      case "distance":
        const distance = Number.parseInt(value)
        if (!isNaN(distance) && distance >= 0) {
          this.updateDistanceDisplay(distance)
        }
        break

      case "motor1":
      case "motor2":
      case "motor3":
      case "motor4":
        const motorValue = Number.parseInt(value)
        if (!isNaN(motorValue) && motorValue >= 0 && motorValue <= 100) {
          const motorData = { [key]: motorValue }
          this.updateMotorStatus(motorData)
        }
        break

      default:
        console.log(`Unknown data key: ${key}`)
    }
  }

  startDataPolling() {
    if (this.isReceivingData) return

    this.isReceivingData = true
    this.dataPollingInterval = setInterval(async () => {
      if (!this.isConnected || !this.dataCharacteristic) {
        this.stopDataReception()
        return
      }

      try {
        const value = await this.dataCharacteristic.readValue()
        this.handleIncomingData(value)
      } catch (error) {
        console.log("Error reading data:", error.message)
      }
    }, 500) // Poll every 500ms
  }

  startWifiDataPolling() {
    if (this.isReceivingData) return

    this.isReceivingData = true
    this.dataPollingInterval = setInterval(async () => {
      if (!this.isConnected || !this.wifiEndpoint) {
        this.stopDataReception()
        return
      }

      try {
        const response = await fetch(`${this.wifiEndpoint}/sensor`, {
          method: "GET",
          timeout: 2000,
        })

        if (response.ok) {
          const data = await response.text()
          this.handleIncomingData(new TextEncoder().encode(data))
        }
      } catch (error) {
        console.log("Error fetching sensor data:", error.message)
      }
    }, 500) // Poll every 500ms
  }

  stopDataReception() {
    this.isReceivingData = false
    this.stopProximityBeeping()

    if (this.dataPollingInterval) {
      clearInterval(this.dataPollingInterval)
      this.dataPollingInterval = null
    }

    if (this.dataCharacteristic) {
      try {
        this.dataCharacteristic.stopNotifications()
      } catch (error) {
        console.log("Error stopping notifications:", error.message)
      }
      this.dataCharacteristic = null
    }
  }

  showIOSGuidance() {
    const guidance = `
      <div style="text-align: left; line-height: 1.6;">
        <h4>iOS Connection Options:</h4>
        <ol>
          <li><strong>WiFi Connection:</strong> Use the WiFi tab to connect via IP address</li>
          <li><strong>Safari Limitations:</strong> Apple restricts Web Bluetooth in all iOS browsers</li>
          <li><strong>Alternative Apps:</strong> Look for dedicated RC car apps in the App Store</li>
          <li><strong>Desktop Alternative:</strong> Use a Mac, PC, or Android device for Bluetooth</li>
        </ol>
        <p><em>We recommend using the WiFi connection method for the best experience on iOS devices.</em></p>
      </div>
    `

    // Create a modal or detailed notification
    const modal = document.createElement("div")
    modal.className = "ios-guidance-modal"
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3>iOS Device Detected</h3>
          <button class="modal-close" onclick="this.parentElement.parentElement.parentElement.remove()">×</button>
        </div>
        <div class="modal-body">
          ${guidance}
        </div>
        <div class="modal-footer">
          <button class="btn" onclick="this.parentElement.parentElement.parentElement.remove()">Got it</button>
        </div>
      </div>
    `

    document.body.appendChild(modal)
  }
}

// Initialize the controller when the page loads
let controller
document.addEventListener("DOMContentLoaded", () => {
  controller = new RCCarController()
})

// Add global error handler
window.addEventListener("error", (event) => {
  console.error("Global error:", event.error)
  if (controller) {
    controller.showNotification("An unexpected error occurred", "error")
  }
})

// Add unhandled promise rejection handler
window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection:", event.reason)
  if (controller) {
    controller.showNotification("Connection error occurred", "error")
  }
})

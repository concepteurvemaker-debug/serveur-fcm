package com.example.secoursproximity

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.util.Log
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.firebase.messaging.FirebaseMessaging
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import kotlin.math.sqrt

class MainActivity : ComponentActivity(), SensorEventListener {

    private enum class AppMode {
        NONE,
        PUBLIC,
        SECOURS
    }

    private val serverBaseUrl = "https://serveur-fcm.onrender.com"
    private val httpClient = OkHttpClient()

    private lateinit var fusedLocationClient: FusedLocationProviderClient
    private lateinit var sensorManager: SensorManager
    private var accelerometer: Sensor? = null
    private var locationCallback: LocationCallback? = null

    private var fcmToken: String? = null
    private var lastLiveLocation: Location? = null
    private var lastMotionUpdateAt = 0L

    private var currentMode by mutableStateOf(AppMode.NONE)
    private var interventionActive by mutableStateOf(false)
    private var statusMessage by mutableStateOf("Choisis un mode.")

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            if (hasLocationPermission()) {
                statusMessage = "Permissions accordees."
                refreshTracking()
            } else {
                statusMessage = "La localisation est necessaire pour l'application."
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        fusedLocationClient = LocationServices.getFusedLocationProviderClient(this)
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        accelerometer = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)

        requestNeededPermissions()
        fetchFcmToken()

        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    AppContent()
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        accelerometer?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL)
        }
    }

    override fun onPause() {
        super.onPause()
        sensorManager.unregisterListener(this)
    }

    override fun onDestroy() {
        super.onDestroy()
        stopLocationTracking()
    }

    override fun onSensorChanged(event: SensorEvent?) {
        if (currentMode != AppMode.SECOURS || !interventionActive) {
            return
        }

        val sensorEvent = event ?: return
        val x = sensorEvent.values[0]
        val y = sensorEvent.values[1]
        val z = sensorEvent.values[2]
        val netAcceleration = sqrt(x * x + y * y + z * z) - SensorManager.GRAVITY_EARTH

        if (netAcceleration > 2.5f && System.currentTimeMillis() - lastMotionUpdateAt > 5_000) {
            lastMotionUpdateAt = System.currentTimeMillis()
            lastLiveLocation?.let { sendSecoursPosition(it) }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private fun requestNeededPermissions() {
        val permissions = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions += Manifest.permission.POST_NOTIFICATIONS
        }

        val missingPermissions = permissions.filterNot { permission ->
            ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED
        }

        if (missingPermissions.isNotEmpty()) {
            permissionLauncher.launch(missingPermissions.toTypedArray())
        }
    }

    private fun fetchFcmToken() {
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (!task.isSuccessful) {
                Log.e("FCM", "Impossible de recuperer le token", task.exception)
                statusMessage = "Token FCM indisponible."
                return@addOnCompleteListener
            }

            fcmToken = task.result
            Log.d("FCM", "Token recu: ${task.result}")
            statusMessage = "Token FCM pret."
            refreshTracking()
        }
    }

    private fun hasLocationPermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_FINE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED || ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED
    }

    private fun selectPublicMode() {
        currentMode = AppMode.PUBLIC
        interventionActive = false
        statusMessage = "Mode public actif."
        refreshTracking()
    }

    private fun selectSecoursMode() {
        currentMode = AppMode.SECOURS
        interventionActive = false
        statusMessage = "Mode secours pret. Lance l'intervention."
        refreshTracking()
    }

    private fun returnToHome() {
        currentMode = AppMode.NONE
        interventionActive = false
        statusMessage = "Choisis un mode."
        stopLocationTracking()
    }

    private fun toggleIntervention() {
        if (currentMode != AppMode.SECOURS) {
            return
        }

        interventionActive = !interventionActive
        statusMessage = if (interventionActive) {
            "Intervention active. Position envoyee automatiquement."
        } else {
            "Intervention arretee."
        }

        refreshTracking()
    }

    private fun refreshTracking() {
        stopLocationTracking()

        if (!hasLocationPermission()) {
            statusMessage = "La permission de localisation est requise."
            return
        }

        if (fcmToken == null) {
            statusMessage = "En attente du token FCM."
            return
        }

        when (currentMode) {
            AppMode.NONE -> Unit
            AppMode.PUBLIC -> startLocationTracking(
                priority = Priority.PRIORITY_BALANCED_POWER_ACCURACY,
                intervalMs = 15_000L,
                minDistanceMeters = 30f,
                onLocation = { location ->
                    registerPublicUser(location)
                },
            )
            AppMode.SECOURS -> {
                if (interventionActive) {
                    startLocationTracking(
                        priority = Priority.PRIORITY_HIGH_ACCURACY,
                        intervalMs = 3_000L,
                        minDistanceMeters = 10f,
                        onLocation = { location ->
                            sendSecoursPosition(location)
                        },
                    )
                }
            }
        }

        pushLastKnownLocation()
    }

    @SuppressLint("MissingPermission")
    private fun startLocationTracking(
        priority: Int,
        intervalMs: Long,
        minDistanceMeters: Float,
        onLocation: (Location) -> Unit,
    ) {
        val request = LocationRequest.Builder(priority, intervalMs)
            .setMinUpdateIntervalMillis(intervalMs / 2)
            .setMinUpdateDistanceMeters(minDistanceMeters)
            .build()

        locationCallback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                val location = result.lastLocation ?: return
                lastLiveLocation = location
                onLocation(location)
            }
        }

        fusedLocationClient.requestLocationUpdates(
            request,
            locationCallback as LocationCallback,
            Looper.getMainLooper(),
        )
    }

    private fun stopLocationTracking() {
        locationCallback?.let { callback ->
            fusedLocationClient.removeLocationUpdates(callback)
        }
        locationCallback = null
    }

    @SuppressLint("MissingPermission")
    private fun pushLastKnownLocation() {
        if (!hasLocationPermission()) {
            return
        }

        fusedLocationClient.lastLocation
            .addOnSuccessListener { location ->
                if (location == null) {
                    return@addOnSuccessListener
                }

                lastLiveLocation = location

                when {
                    currentMode == AppMode.PUBLIC -> registerPublicUser(location)
                    currentMode == AppMode.SECOURS && interventionActive -> sendSecoursPosition(location)
                }
            }
            .addOnFailureListener { error ->
                Log.e("GPS", "Impossible de recuperer la derniere position", error)
            }
    }

    private fun registerPublicUser(location: Location) {
        val token = fcmToken ?: return

        val payload = JSONObject()
            .put("token", token)
            .put("lat", location.latitude)
            .put("lng", location.longitude)
            .put("modePublic", true)

        postJson(
            path = "/register-user",
            payload = payload,
            logTag = "PUBLIC",
            successMessage = "Position public mise a jour.",
        )
    }

    private fun sendSecoursPosition(location: Location) {
        val token = fcmToken ?: return

        val payload = JSONObject()
            .put("token", token)
            .put("lat", location.latitude)
            .put("lng", location.longitude)

        postJson(
            path = "/update-position",
            payload = payload,
            logTag = "SECOURS",
            successMessage = "Position secours envoyee.",
        )
    }

    private fun sendManualAlert() {
        val location = lastLiveLocation

        if (location == null) {
            Toast.makeText(this, "Attends la premiere position GPS.", Toast.LENGTH_SHORT).show()
            return
        }

        val payload = JSONObject()
            .put("lat", location.latitude)
            .put("lng", location.longitude)

        postJson(
            path = "/alert",
            payload = payload,
            logTag = "ALERTE",
            successMessage = "Alerte immediate envoyee.",
        )
    }

    private fun postJson(
        path: String,
        payload: JSONObject,
        logTag: String,
        successMessage: String,
    ) {
        val requestBody = payload.toString()
            .toRequestBody("application/json; charset=utf-8".toMediaType())

        val request = Request.Builder()
            .url(serverBaseUrl + path)
            .post(requestBody)
            .build()

        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                Log.e(logTag, "Erreur reseau", e)
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val responseBody = it.body?.string().orEmpty()
                    Log.d(logTag, "HTTP ${it.code}: $responseBody")

                    if (it.isSuccessful) {
                        runOnUiThread {
                            statusMessage = successMessage
                        }
                    }
                }
            }
        })
    }

    @Composable
    private fun AppContent() {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(text = statusMessage, style = MaterialTheme.typography.bodyLarge)
            Spacer(modifier = Modifier.height(24.dp))

            when (currentMode) {
                AppMode.NONE -> ModeSelectionScreen()
                AppMode.PUBLIC -> PublicScreen()
                AppMode.SECOURS -> SecoursScreen()
            }

            lastLiveLocation?.let { location ->
                Spacer(modifier = Modifier.height(16.dp))
                Text(
                    text = "Derniere position: %.5f, %.5f".format(
                        location.latitude,
                        location.longitude,
                    ),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }

    @Composable
    private fun ModeSelectionScreen() {
        Button(onClick = { selectSecoursMode() }) {
            Text("Mode secours")
        }

        Spacer(modifier = Modifier.height(16.dp))

        Button(onClick = { selectPublicMode() }) {
            Text("Mode public")
        }
    }

    @Composable
    private fun PublicScreen() {
        Text("Le mode public envoie ta position pour recevoir les alertes proches.")
        Spacer(modifier = Modifier.height(16.dp))
        Button(onClick = { returnToHome() }) {
            Text("Retour")
        }
    }

    @Composable
    private fun SecoursScreen() {
        Text(
            if (interventionActive) {
                "Intervention en cours"
            } else {
                "Intervention arretee"
            },
        )

        Spacer(modifier = Modifier.height(16.dp))

        Button(onClick = { toggleIntervention() }) {
            Text(if (interventionActive) "Arreter intervention" else "Demarrer intervention")
        }

        Spacer(modifier = Modifier.height(16.dp))

        Button(onClick = { sendManualAlert() }) {
            Text("Envoyer une alerte immediate")
        }

        Spacer(modifier = Modifier.height(16.dp))

        Button(onClick = { returnToHome() }) {
            Text("Retour")
        }
    }
}

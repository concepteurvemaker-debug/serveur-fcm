package com.example.secoursproximity

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException

class LocationForegroundService : Service() {

    private val httpClient = OkHttpClient()

    private lateinit var fusedLocationClient: FusedLocationProviderClient
    private var locationCallback: LocationCallback? = null

    private var fcmToken: String? = null
    private var serverBaseUrl: String = DEFAULT_SERVER_URL

    override fun onCreate() {
        super.onCreate()
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(this)
        createNotificationChannel()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                fcmToken = intent.getStringExtra(EXTRA_FCM_TOKEN)
                serverBaseUrl = intent.getStringExtra(EXTRA_SERVER_URL) ?: DEFAULT_SERVER_URL

                if (fcmToken.isNullOrBlank()) {
                    Log.e("FGS", "Token secours manquant, arret du service")
                    stopTrackingAndSelf()
                    return START_NOT_STICKY
                }

                startForegroundSafely()
                startLocationTracking()
            }

            ACTION_STOP -> {
                stopTrackingAndSelf()
            }
        }

        return START_NOT_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        stopLocationTracking()
    }

    private fun startForegroundSafely() {
        val notification = buildNotification()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(): Notification {
        val openAppIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }

        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            openAppIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Mode secours actif")
            .setContentText("Suivi GPS en arriere-plan en cours")
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }

        val channel = NotificationChannel(
            CHANNEL_ID,
            "Suivi secours",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Notification persistante du suivi GPS secours"
            setSound(null, null)
        }

        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }

    @SuppressLint("MissingPermission")
    private fun startLocationTracking() {
        if (!hasLocationPermission()) {
            Log.e("FGS", "Permission de localisation manquante")
            stopTrackingAndSelf()
            return
        }

        stopLocationTracking()

        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 3_000L)
            .setMinUpdateIntervalMillis(1_500L)
            .setMinUpdateDistanceMeters(10f)
            .build()

        locationCallback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                val location = result.lastLocation ?: return
                sendSecoursPosition(location.latitude, location.longitude)
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

    private fun stopTrackingAndSelf() {
        stopLocationTracking()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
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

    private fun sendSecoursPosition(lat: Double, lng: Double) {
        val token = fcmToken ?: return

        val payload = JSONObject()
            .put("token", token)
            .put("lat", lat)
            .put("lng", lng)

        val requestBody = payload.toString()
            .toRequestBody("application/json; charset=utf-8".toMediaType())

        val request = Request.Builder()
            .url(serverBaseUrl + "/update-position")
            .post(requestBody)
            .build()

        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                Log.e("FGS", "Erreur reseau secours", e)
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    Log.d("FGS", "HTTP ${it.code}: ${it.body?.string().orEmpty()}")
                }
            }
        })
    }

    companion object {
        const val ACTION_START = "com.example.secoursproximity.action.START_SECOURS_TRACKING"
        const val ACTION_STOP = "com.example.secoursproximity.action.STOP_SECOURS_TRACKING"
        const val EXTRA_SERVER_URL = "extra_server_url"
        const val EXTRA_FCM_TOKEN = "extra_fcm_token"

        private const val CHANNEL_ID = "secours_tracking_service"
        private const val NOTIFICATION_ID = 2001
        private const val DEFAULT_SERVER_URL = "https://serveur-fcm.onrender.com"
    }
}

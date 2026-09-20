import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// امضای نسخه‌ی release از فایل keystore.properties خوانده می‌شود (در گیت نیست).
// نمونه‌ی محتوای آن در keystore.properties.example هست.
val keystoreProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "com.example.messenger"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.example.messenger"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"

        // نشانی سرور پیام‌رسان؛ هنگام بیلد قابل تغییر است و کاربر هم می‌تواند
        // در خود برنامه آن را عوض کند (منوی «تنظیم نشانی سرور»).
        buildConfigField("String", "DEFAULT_SERVER_URL", "\"http://10.0.2.2:3000\"")
    }

    signingConfigs {
        if (keystoreProperties.getProperty("storeFile") != null) {
            create("release") {
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildFeatures {
        buildConfig = true
        viewBinding = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // اگر keystore تعریف شده باشد نسخه‌ی release با آن امضا می‌شود،
            // وگرنه بیلد release بدون امضا ساخته می‌شود.
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.1")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("com.google.android.material:material:1.12.0")
}

package com.lusciousdl.app;

import android.os.Bundle;
import android.view.KeyEvent;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LdlStoragePlugin.class);
        super.onCreate(savedInstanceState);
    }

    // While reading, the volume keys turn pages instead of changing the volume.
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        if (LdlStoragePlugin.captureVolume && (code == KeyEvent.KEYCODE_VOLUME_DOWN || code == KeyEvent.KEYCODE_VOLUME_UP)) {
            if (event.getAction() == KeyEvent.ACTION_DOWN) LdlStoragePlugin.volumeKey(code == KeyEvent.KEYCODE_VOLUME_DOWN ? 1 : -1);
            return true;
        }
        return super.dispatchKeyEvent(event);
    }
}

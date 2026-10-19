// Release builds are GUI apps: no console window attached to snack.exe
// (closing that console used to kill the app).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    snack_lib::run();
}

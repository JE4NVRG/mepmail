// Release builds must not open a console window next to the app window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mepmail_correio_lib::run()
}

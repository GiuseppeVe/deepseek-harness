use std::env;

use dsh_desktop::{resolve_desktop_paths_for_test, DesktopPathsTestRequest};

fn main() {
    let mut arguments = env::args().skip(1);
    if arguments.next().as_deref() == Some("resolve-desktop-paths") {
        let request = arguments
            .next()
            .expect("resolve-desktop-paths requires JSON input");
        let request: DesktopPathsTestRequest =
            serde_json::from_str(&request).expect("resolve-desktop-paths input must be JSON");
        println!(
            "{}",
            serde_json::to_string(&resolve_desktop_paths_for_test(request))
                .expect("desktop paths must serialize")
        );
        return;
    }

    dsh_desktop::run().expect("DSH Desktop host failed");
}

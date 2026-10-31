use std::env;
use std::fs::File;
use std::hint::black_box;
use std::io::{self, BufRead, BufReader, Write};
use std::thread;
use std::time::Duration;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = env::args().nth(1).ok_or("expected a session path")?;
    let mut entries = Vec::new();
    let mut text_bytes = 0usize;
    for line in BufReader::new(File::open(path)?).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        text_bytes += entry["message"]["content"][0]["text"]
            .as_str()
            .map_or(0, str::len);
        entries.push(entry);
    }
    let valid_header = entries.first().is_some_and(|entry| {
        entry["type"] == "session" && entry["id"].is_string()
    });
    if !valid_header {
        entries.clear();
        text_bytes = 0;
    }
    println!("READY {} {text_bytes}", entries.len());
    io::stdout().flush()?;
    thread::sleep(Duration::from_secs(2));
    black_box(&entries);
    Ok(())
}

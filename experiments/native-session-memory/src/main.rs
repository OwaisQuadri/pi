use serde::Deserialize;
use std::collections::HashMap;
use std::env;
use std::fs::File;
use std::io::{self, BufRead, BufReader};
use std::thread;
use std::time::Duration;

#[derive(Deserialize)]
#[allow(dead_code)]
struct Entry {
    #[serde(rename = "type")]
    kind: String,
    id: String,
    #[serde(rename = "parentId")]
    parent_id: Option<String>,
    message: Message,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct Message {
    role: String,
    content: Vec<Part>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct Part {
    #[serde(rename = "type")]
    kind: String,
    text: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let path = args.next().ok_or("expected session path")?;
    let mode = args.next().unwrap_or_else(|| "typed".to_string());
    let mut bytes = 0;
    if mode == "generic" {
        let mut entries = Vec::new();
        for line in BufReader::new(File::open(&path)?).lines() {
            let line = line?;
            if line.trim().is_empty() { continue; }
            let entry: serde_json::Value = serde_json::from_str(&line)?;
            bytes += entry["message"]["content"][0]["text"].as_str().map_or(0, str::len);
            entries.push(entry);
        }
        println!("READY {} {bytes}", entries.len());
        io::Write::flush(&mut io::stdout())?;
        thread::sleep(Duration::from_secs(2));
        std::hint::black_box(&entries);
    } else if mode == "lazy" {
        let mut entries = Vec::new();
        for line in BufReader::new(File::open(&path)?).lines() {
            let line = line?;
            if line.trim().is_empty() { continue; }
            let entry: serde_json::Value = serde_json::from_str(&line)?;
            bytes += entry["message"]["content"][0]["text"].as_str().map_or(0, str::len);
            entries.push((
                entry["id"].as_str().map(str::to_owned),
                entry["parentId"].as_str().map(str::to_owned),
                line,
            ));
        }
        println!("READY {} {bytes}", entries.len());
        io::Write::flush(&mut io::stdout())?;
        thread::sleep(Duration::from_secs(2));
        std::hint::black_box(&entries);
    } else if mode == "serve" {
        let mut entries = HashMap::new();
        for line in BufReader::new(File::open(&path)?).lines() {
            let line = line?;
            if line.trim().is_empty() { continue; }
            let entry: serde_json::Value = serde_json::from_str(&line)?;
            if let Some(id) = entry["id"].as_str() {
                entries.insert(id.to_owned(), line);
            }
        }
        println!("READY {}", entries.len());
        io::Write::flush(&mut io::stdout())?;
        for request in io::stdin().lock().lines() {
            let request: serde_json::Value = serde_json::from_str(&request?)?;
            let response = request["id"].as_str().and_then(|id| entries.get(id));
            println!("{}", response.map_or("null", String::as_str));
            io::Write::flush(&mut io::stdout())?;
        }
    } else if mode == "typed" {
        let mut entries = Vec::new();
        for line in BufReader::new(File::open(&path)?).lines() {
            let line = line?;
            if line.trim().is_empty() { continue; }
            let entry: Entry = serde_json::from_str(&line)?;
            bytes += entry.message.content[0].text.len();
            entries.push(entry);
        }
        println!("READY {} {bytes}", entries.len());
        io::Write::flush(&mut io::stdout())?;
        thread::sleep(Duration::from_secs(2));
        std::hint::black_box(&entries);
    } else {
        return Err(format!("unknown mode: {mode}").into());
    }
    Ok(())
}

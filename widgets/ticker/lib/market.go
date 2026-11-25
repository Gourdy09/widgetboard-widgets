package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// One client with a timeout: a stalled upstream must never hang a handler on a small device.
var upstream = &http.Client{Timeout: 10 * time.Second}

func stockHandler(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	symbol := orDefault(q.Get("symbol"), "AAPL")
	rangeVal := orDefault(q.Get("range"), "7d")
	interval := orDefault(q.Get("interval"), "1h")

	yahooURL := fmt.Sprintf("https://query1.finance.yahoo.com/v8/finance/chart/%s?range=%s&interval=%s",
		url.PathEscape(symbol), url.QueryEscape(rangeVal), url.QueryEscape(interval))
	req, err := http.NewRequest("GET", yahooURL, nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")

	resp, err := upstream.Do(req)
	if err != nil {
		fmt.Println("Yahoo fetch error:", err)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// symbolsHandler powers the ticker search box in the admin panel: GET /api/symbols?q=apple
// returns [{ "value": "AAPL", "label": "AAPL — Apple Inc. (NASDAQ)" }, ...].
func symbolsHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" || len(q) > 40 {
		w.Write([]byte("[]"))
		return
	}

	req, err := http.NewRequest("GET", "https://query1.finance.yahoo.com/v1/finance/search?quotesCount=8&newsCount=0&q="+url.QueryEscape(q), nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	req.Header.Set("User-Agent", "Mozilla/5.0")

	resp, err := upstream.Do(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		http.Error(w, "symbol search unavailable", http.StatusBadGateway)
		return
	}

	var payload struct {
		Quotes []struct {
			Symbol    string `json:"symbol"`
			ShortName string `json:"shortname"`
			LongName  string `json:"longname"`
			Exchange  string `json:"exchDisp"`
		} `json:"quotes"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&payload); err != nil {
		http.Error(w, "bad response from symbol search", http.StatusBadGateway)
		return
	}

	type option struct {
		Value string `json:"value"`
		Label string `json:"label"`
	}
	out := make([]option, 0, len(payload.Quotes))
	for _, quote := range payload.Quotes {
		if quote.Symbol == "" {
			continue
		}
		name := quote.LongName
		if name == "" {
			name = quote.ShortName
		}
		label := quote.Symbol
		if name != "" {
			label += " \u2014 " + name
		}
		if quote.Exchange != "" {
			label += " (" + quote.Exchange + ")"
		}
		out = append(out, option{Value: quote.Symbol, Label: label})
	}
	json.NewEncoder(w).Encode(out)
}

func orDefault(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}

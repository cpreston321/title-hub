use serde::{Deserialize, Serialize};

/// Mirrors `FileSnapshot` in convex/integrations/types.ts. Wire format is
/// camelCase so the server's `fileSnapshotV` validator (in
/// convex/integrations.ts) accepts the JSON unchanged. Idiomatic Rust
/// snake_case on the field names; serde renames on the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSnapshot {
    pub external_id: String,
    pub file_number: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub county_fips: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transaction_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub property_apn: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub property_address: Option<Address>,
    #[serde(default)]
    pub parties: Vec<Party>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Address {
    pub line1: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line2: Option<String>,
    pub city: String,
    pub state: String,
    pub zip: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Party {
    pub role: String,
    pub legal_name: String,
    pub party_type: PartyType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capacity: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PartyType {
    Person,
    Entity,
    Trust,
    Estate,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn party_type_serializes_lowercase_to_match_server_enum() {
        // Server's `partyType` validator in convex/integrations.ts accepts:
        //   'person' | 'entity' | 'trust' | 'estate'
        for (variant, wire) in [
            (PartyType::Person, "person"),
            (PartyType::Entity, "entity"),
            (PartyType::Trust, "trust"),
            (PartyType::Estate, "estate"),
        ] {
            let s = serde_json::to_string(&variant).unwrap();
            assert_eq!(s, format!("\"{wire}\""));
        }
    }

    #[test]
    fn snapshot_serializes_camel_case_keys() {
        let snap = FileSnapshot {
            external_id: "ext-1".into(),
            file_number: "F-1".into(),
            external_status: Some("opened".into()),
            state_code: Some("IN".into()),
            county_fips: Some("18097".into()),
            transaction_type: Some("purchase".into()),
            property_apn: None,
            property_address: Some(Address {
                line1: "1 Main".into(),
                line2: None,
                city: "Indy".into(),
                state: "IN".into(),
                zip: "46204".into(),
            }),
            parties: vec![Party {
                role: "buyer".into(),
                legal_name: "Bob".into(),
                party_type: PartyType::Person,
                capacity: Some("AIF".into()),
            }],
            updated_at: 1_700_000_000_000,
        };
        let v: Value = serde_json::to_value(&snap).unwrap();
        assert_eq!(v["externalId"], "ext-1");
        assert_eq!(v["fileNumber"], "F-1");
        assert_eq!(v["externalStatus"], "opened");
        assert_eq!(v["stateCode"], "IN");
        assert_eq!(v["countyFips"], "18097");
        assert_eq!(v["transactionType"], "purchase");
        assert_eq!(v["propertyAddress"]["line1"], "1 Main");
        assert_eq!(v["parties"][0]["legalName"], "Bob");
        assert_eq!(v["parties"][0]["partyType"], "person");
        assert_eq!(v["parties"][0]["capacity"], "AIF");
        assert_eq!(v["updatedAt"], 1_700_000_000_000_i64);
    }

    #[test]
    fn snapshot_omits_optional_none_fields() {
        let snap = FileSnapshot {
            external_id: "ext-1".into(),
            file_number: "F-1".into(),
            external_status: None,
            state_code: None,
            county_fips: None,
            transaction_type: None,
            property_apn: None,
            property_address: None,
            parties: vec![],
            updated_at: 0,
        };
        let v: Value = serde_json::to_value(&snap).unwrap();
        assert!(v.get("externalStatus").is_none());
        assert!(v.get("stateCode").is_none());
        assert!(v.get("countyFips").is_none());
        assert!(v.get("transactionType").is_none());
        assert!(v.get("propertyApn").is_none());
        assert!(v.get("propertyAddress").is_none());
        // Empty parties array is allowed (not None).
        assert_eq!(v["parties"], json!([]));
    }

    #[test]
    fn snapshot_round_trips_through_camel_case_json() {
        // The agent might one day deserialize what it just sent (e.g. for a
        // local replay). camelCase rename has to work both directions.
        let original = FileSnapshot {
            external_id: "ext-1".into(),
            file_number: "F-1".into(),
            external_status: None,
            state_code: Some("IN".into()),
            county_fips: None,
            transaction_type: None,
            property_apn: None,
            property_address: None,
            parties: vec![Party {
                role: "seller".into(),
                legal_name: "Sam".into(),
                party_type: PartyType::Entity,
                capacity: None,
            }],
            updated_at: 1,
        };
        let s = serde_json::to_string(&original).unwrap();
        let back: FileSnapshot = serde_json::from_str(&s).unwrap();
        assert_eq!(back.external_id, original.external_id);
        assert_eq!(back.parties[0].legal_name, "Sam");
        assert_eq!(back.parties[0].party_type, PartyType::Entity);
    }
}

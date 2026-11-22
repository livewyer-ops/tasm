use crate::host::{Error, Host};
use serde_json::Value;
use std::ops::{Deref, DerefMut};

#[derive(Clone)]
pub struct Pool(pub Host);
pub struct Connection(pub Host);

pub struct Transaction {
    connection: Connection,
    finished: bool,
}
impl Pool {
    pub async fn begin(&self) -> Result<Transaction, Error> {
        self.0.call("begin", Value::Null).await?;
        Ok(Transaction {
            connection: Connection(self.0.clone()),
            finished: false,
        })
    }
}
impl Deref for Transaction {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        &self.connection
    }
}
impl DerefMut for Transaction {
    fn deref_mut(&mut self) -> &mut Connection {
        &mut self.connection
    }
}
impl Transaction {
    pub async fn commit(mut self) -> Result<(), Error> {
        self.connection.0.call("commit", Value::Null).await?;
        self.finished = true;
        Ok(())
    }
    pub async fn rollback(mut self) -> Result<(), Error> {
        self.connection.0.call("rollback", Value::Null).await?;
        self.finished = true;
        Ok(())
    }
}
impl Drop for Transaction {
    fn drop(&mut self) {
        if !self.finished {
            self.connection.0.fire("rollback", Value::Null);
        }
    }
}

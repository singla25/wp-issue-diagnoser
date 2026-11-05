<?php
if ( class_exists( 'mysql_fetch_array' ) ) {
	mysql_fetch_array( $r );
}
if ( ! class_exists( 'mysql_fetch_array' ) ) {
	mysql_fetch_array( $r );
}
if ( defined( 'mysql_fetch_array' ) ) {
	mysql_fetch_array( $r );
}
if ( ! defined( 'mysql_fetch_array' ) ) {
	mysql_fetch_array( $r );
}
if ( interface_exists( 'mysql_fetch_array' ) || trait_exists( 'mysql_fetch_array' ) ) {
	mysql_fetch_array( $r );
}
